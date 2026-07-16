//! # SteamNetworkManager
//!
//! Clean encapsulation of Steam Matchmaking + Networking Messages for DUSTLINE 1v1.
//!
//! Maps to the classic C++ Steamworks flow:
//! - `SteamAPI_Init` / `RunCallbacks`     → [`SteamNetworkManager::try_init`] + callback thread
//! - `ISteamMatchmaking::CreateLobby`    → [`SteamNetworkManager::create_lobby`]
//! - `RequestLobbyList` / `JoinLobby`    → [`request_lobby_list`] / [`join_lobby`]
//! - `LobbyChatUpdate_t`                 → polled member diffs + emit
//! - `ISteamNetworkingMessages`          → P2P send/recv + handshake channel
//!
//! ## App ID
//! Development uses **480 (Spacewar)** via `steam_appid.txt`. Replace with your real AppID
//! for shipping. Never ship a game that still points at 480.
//!
//! ## Pitfalls
//! 1. Steam client must be **running and logged in** or init fails.
//! 2. Callbacks only fire if `run_callbacks` runs regularly (we use a 5 ms thread).
//! 3. Lobby list metadata is **eventually consistent** — empty results right after create are normal.
//! 4. Spacewar (480) shares lobby lists with every other test game → always filter by game key.
//! 5. Only **one** `RequestLobbyList` in flight at a time (we serialize with a mutex).
//! 6. `JoinLobby` fails if full / deleted — treat as soft error and re-list.
//! 7. Host leave in 1v1 → end lobby (no host migration needed).
//! 8. Firewall/antivirus can block Steam relay; overlay helps diagnose.
//! 9. P2P needs `init_relay_network_access()` for internet NAT traversal.
//! 10. Rich Presence `connect` enables friend-invite deep link (`+connect_lobby <id>`).

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use steamworks::networking_types::{NetworkingIdentity, SendFlags};
use steamworks::{
    Client, DistanceFilter, GameLobbyJoinRequested, LobbyId, LobbyKey, LobbyListFilter, LobbyType,
    SteamId, StringFilter, StringFilterKind,
};
use tauri::{AppHandle, Emitter};

// ── Constants ─────────────────────────────────────────────────────

/// Spacewar test AppID. Production: replace steam_appid.txt + partner settings.
pub const STEAM_APP_ID_TEST: u32 = 480;

/// Max players per lobby (1v1).
pub const LOBBY_MAX_MEMBERS: u32 = 2;

/// Lobby data keys (string metadata visible in filters).
pub const LOBBY_DATA_GAME: &str = "game";
pub const LOBBY_DATA_GAME_VAL: &str = "DUSTLINE";
pub const LOBBY_DATA_STATUS: &str = "status";
pub const LOBBY_DATA_MAP: &str = "map";
pub const LOBBY_DATA_HOST: &str = "host";
pub const LOBBY_DATA_VER: &str = "ver";
pub const STATUS_WAITING: &str = "waiting";
pub const STATUS_PLAYING: &str = "playing";

/// Default map metadata for lobby browser.
pub const DEFAULT_MAP: &str = "island";

/// Networking Messages channels (must match game net layer).
pub const CH_INPUT: u32 = 0;
pub const CH_STATE: u32 = 1;
pub const CH_EVENTS: u32 = 2;
/// Dedicated handshake / ping channel.
pub const CH_HANDSHAKE: u32 = 3;

const CHANNEL_COUNT: u32 = 4;

// ── Public types ──────────────────────────────────────────────────

/// High-level session state (UI + game logic).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SteamSessionState {
    #[default]
    Idle,
    /// CreateLobby in flight
    CreatingLobby,
    /// We own a lobby, waiting for peer
    HostingLobby,
    /// JoinLobby in flight
    JoiningLobby,
    /// In someone else's lobby as guest
    InLobby,
    /// 2 players present — P2P handshake running
    Connecting,
    /// Handshake OK / match may start
    InGame,
    Error,
}

/// Lobby visibility (maps to Steam LobbyType).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LobbyVisibility {
    Public,
    FriendsOnly,
    /// Invisible except by ID / invite
    Private,
}

impl LobbyVisibility {
    fn to_steam(self) -> LobbyType {
        match self {
            LobbyVisibility::Public => LobbyType::Public,
            LobbyVisibility::FriendsOnly => LobbyType::FriendsOnly,
            LobbyVisibility::Private => LobbyType::Private,
        }
    }
}

/// One row in the lobby browser.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LobbyListEntry {
    pub lobby_id: u64,
    pub owner_id: u64,
    pub owner_name: String,
    pub members: u32,
    pub max_members: u32,
    pub map: String,
    pub status: String,
    pub version: String,
    /// Steam does not give true ping in list API; placeholder for UI.
    pub ping_ms: Option<u32>,
}

/// One lobby member for UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LobbyMember {
    pub steam_id: u64,
    pub name: String,
    pub is_host: bool,
    pub is_local: bool,
}

/// Events emitted to the game / UI (Tauri `steam_event` or specific channels).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SteamEvent {
    InitOk {
        steam_id: u64,
        name: String,
    },
    InitFailed {
        error: String,
    },
    StateChanged {
        state: SteamSessionState,
        detail: String,
    },
    LobbyCreated {
        lobby_id: u64,
        success: bool,
        error: Option<String>,
    },
    LobbyList {
        lobbies: Vec<LobbyListEntry>,
    },
    LobbyEntered {
        lobby_id: u64,
        success: bool,
        is_host: bool,
        error: Option<String>,
    },
    LobbyMembers {
        lobby_id: u64,
        members: Vec<LobbyMember>,
    },
    MemberJoined {
        steam_id: u64,
        name: String,
    },
    MemberLeft {
        steam_id: u64,
        name: String,
    },
    LobbyClosed {
        reason: String,
    },
    /// P2P handshake progress
    Handshake {
        peer_id: u64,
        rtt_ms: Option<u32>,
        ok: bool,
        detail: String,
    },
    /// Ready for match (2 players + handshake)
    MatchReady {
        is_host: bool,
        peer_id: u64,
        peer_name: String,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HandshakeMsg {
    kind: String, // "ping" | "pong" | "hello"
    tick: u64,
    name: String,
    #[serde(default)]
    sent_ms: u64,
}

// ── Manager ───────────────────────────────────────────────────────

pub struct SteamNetworkManager {
    client: Client,
    /// Bumps cancel in-flight list/create workers.
    op_gen: AtomicU64,
    creating: AtomicBool,
    listing: AtomicBool,
    mm_lock: Mutex<()>,
    inner: Mutex<ManagerInner>,
}

struct ManagerInner {
    state: SteamSessionState,
    lobby_id: Option<u64>,
    is_host: bool,
    local_id: u64,
    local_name: String,
    peer_id: Option<u64>,
    peer_name: String,
    members: Vec<LobbyMember>,
    last_member_ids: HashSet<u64>,
    handshake_ok: bool,
    handshake_rtt_ms: Option<u32>,
    last_ping_ms: u64,
    detail: String,
}

impl ManagerInner {
    fn new(local_id: u64, local_name: String) -> Self {
        Self {
            state: SteamSessionState::Idle,
            lobby_id: None,
            is_host: false,
            local_id,
            local_name,
            peer_id: None,
            peer_name: String::new(),
            members: Vec::new(),
            last_member_ids: HashSet::new(),
            handshake_ok: false,
            handshake_rtt_ms: None,
            last_ping_ms: 0,
            detail: "Idle".into(),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl SteamNetworkManager {
    // ── 1. STEAM INIT ─────────────────────────────────────────────

    /// `SteamAPI_Init` equivalent. Starts a thread that runs `SteamAPI_RunCallbacks`.
    pub fn try_init() -> Result<Arc<Self>, String> {
        let (client, single) = Client::init().map_err(|e| {
            format!(
                "SteamAPI_Init failed: {:?}. \
                 Start the Steam client, stay logged in, keep steam_api64.dll + steam_appid.txt \
                 (AppID {STEAM_APP_ID_TEST} for tests) next to the executable.",
                e
            )
        })?;

        // Required so Networking Messages use Steam Datagram Relay (NAT traversal).
        client.networking_utils().init_relay_network_access();

        // Accept inbound Networking Messages sessions automatically.
        client
            .networking_messages()
            .session_request_callback(|req| {
                req.accept();
            });

        // SteamAPI_RunCallbacks — must run every frame / ~every few ms.
        std::thread::spawn(move || loop {
            single.run_callbacks();
            std::thread::sleep(Duration::from_millis(5));
        });

        let local_id = client.user().steam_id().raw();
        let local_name = client.friends().name();

        let mgr = Arc::new(Self {
            client,
            op_gen: AtomicU64::new(0),
            creating: AtomicBool::new(false),
            listing: AtomicBool::new(false),
            mm_lock: Mutex::new(()),
            inner: Mutex::new(ManagerInner::new(local_id, local_name.clone())),
        });

        Ok(mgr)
    }

    pub fn steam_id(&self) -> u64 {
        self.client.user().steam_id().raw()
    }

    pub fn persona_name(&self) -> String {
        self.client.friends().name()
    }

    pub fn state(&self) -> SteamSessionState {
        self.inner.lock().map(|i| i.state).unwrap_or(SteamSessionState::Idle)
    }

    pub fn lobby_id(&self) -> Option<u64> {
        self.inner.lock().ok().and_then(|i| i.lobby_id)
    }

    pub fn is_host(&self) -> bool {
        self.inner.lock().map(|i| i.is_host).unwrap_or(false)
    }

    pub fn peer_id(&self) -> Option<u64> {
        self.inner.lock().ok().and_then(|i| i.peer_id)
    }

    pub fn handshake_ok(&self) -> bool {
        self.inner.lock().map(|i| i.handshake_ok).unwrap_or(false)
    }

    fn mm(&self) -> steamworks::Matchmaking<steamworks::ClientManager> {
        self.client.matchmaking()
    }

    fn emit(app: &AppHandle, ev: SteamEvent) {
        let _ = app.emit("steam_event", &ev);
        // Also mirror a short status string for existing UI
        match &ev {
            SteamEvent::StateChanged { detail, .. } => {
                let _ = app.emit("steam_status", detail.clone());
            }
            SteamEvent::Error { message } => {
                let _ = app.emit("steam_status", message.clone());
            }
            SteamEvent::LobbyCreated { lobby_id, success, .. } if *success => {
                let _ = app.emit("steam_status", format!("Lobby created {lobby_id}"));
            }
            SteamEvent::LobbyEntered { lobby_id, success, .. } if *success => {
                let _ = app.emit("steam_status", format!("Entered lobby {lobby_id}"));
            }
            SteamEvent::MatchReady { peer_name, .. } => {
                let _ = app.emit("steam_status", format!("Match ready vs {peer_name}"));
            }
            SteamEvent::Handshake { detail, .. } => {
                let _ = app.emit("steam_status", detail.clone());
            }
            _ => {}
        }
    }

    fn set_state(&self, app: Option<&AppHandle>, state: SteamSessionState, detail: impl Into<String>) {
        let detail = detail.into();
        if let Ok(mut inner) = self.inner.lock() {
            inner.state = state;
            inner.detail = detail.clone();
        }
        if let Some(app) = app {
            Self::emit(
                app,
                SteamEvent::StateChanged {
                    state,
                    detail,
                },
            );
        }
    }

    fn name_of(&self, id: u64) -> String {
        if id == 0 {
            return String::new();
        }
        let n = self.client.friends().get_friend(SteamId::from_raw(id)).name();
        if n.is_empty() {
            format!("Player-{}", id % 10_000)
        } else {
            n
        }
    }

    // ── 2. CREATE LOBBY ───────────────────────────────────────────

    /// `ISteamMatchmaking::CreateLobby`
    ///
    /// - `visibility`: Public / FriendsOnly / Private
    /// - max members: [`LOBBY_MAX_MEMBERS`] (2 for 1v1)
    ///
    /// Result delivered via `LobbyCreated` event (success/fail).
    pub fn create_lobby(
        self: &Arc<Self>,
        app: AppHandle,
        visibility: LobbyVisibility,
    ) {
        if self
            .creating
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            Self::emit(
                &app,
                SteamEvent::Error {
                    message: "CreateLobby already in progress".into(),
                },
            );
            return;
        }

        // Leave previous lobby first
        self.leave_lobby_internal(None);

        self.set_state(
            Some(&app),
            SteamSessionState::CreatingLobby,
            "Creating lobby…",
        );

        let steam = Arc::clone(self);
        let lobby_type = visibility.to_steam();
        std::thread::spawn(move || {
            let (tx, rx) = std::sync::mpsc::channel();
            steam.mm().create_lobby(lobby_type, LOBBY_MAX_MEMBERS, move |res| {
                let _ = tx.send(res);
            });

            // Wait for LobbyCreated_t (via callback thread)
            let deadline = Instant::now() + Duration::from_secs(12);
            let result = loop {
                if let Ok(res) = rx.try_recv() {
                    break res;
                }
                if Instant::now() > deadline {
                    steam.creating.store(false, Ordering::SeqCst);
                    steam.set_state(
                        Some(&app),
                        SteamSessionState::Error,
                        "CreateLobby timed out",
                    );
                    Self::emit(
                        &app,
                        SteamEvent::LobbyCreated {
                            lobby_id: 0,
                            success: false,
                            error: Some("timeout".into()),
                        },
                    );
                    return;
                }
                std::thread::sleep(Duration::from_millis(16));
            };

            steam.creating.store(false, Ordering::SeqCst);

            match result {
                Ok(lobby_id) => {
                    // SetLobbyData — game filter + map + host + waiting
                    steam.apply_lobby_metadata(lobby_id, true);
                    let id = lobby_id.raw();
                    let me = steam.steam_id();
                    let me_name = steam.persona_name();
                    if let Ok(mut inner) = steam.inner.lock() {
                        inner.lobby_id = Some(id);
                        inner.is_host = true;
                        inner.state = SteamSessionState::HostingLobby;
                        inner.peer_id = None;
                        inner.peer_name.clear();
                        inner.handshake_ok = false;
                        inner.members = vec![LobbyMember {
                            steam_id: me,
                            name: me_name.clone(),
                            is_host: true,
                            is_local: true,
                        }];
                        inner.last_member_ids = HashSet::from([me]);
                        inner.detail = format!("Hosting lobby {id}");
                    }
                    // Rich Presence for friend invites
                    let _ = steam.client.friends().set_rich_presence(
                        "status",
                        Some("Hosting DUSTLINE lobby"),
                    );
                    let _ = steam.client.friends().set_rich_presence(
                        "connect",
                        Some(&format!("+connect_lobby {id}")),
                    );

                    Self::emit(
                        &app,
                        SteamEvent::LobbyCreated {
                            lobby_id: id,
                            success: true,
                            error: None,
                        },
                    );
                    steam.set_state(
                        Some(&app),
                        SteamSessionState::HostingLobby,
                        format!("Hosting lobby {id}"),
                    );
                    steam.emit_members(&app);
                }
                Err(e) => {
                    steam.set_state(
                        Some(&app),
                        SteamSessionState::Error,
                        format!("CreateLobby failed: {e:?}"),
                    );
                    Self::emit(
                        &app,
                        SteamEvent::LobbyCreated {
                            lobby_id: 0,
                            success: false,
                            error: Some(format!("{e:?}")),
                        },
                    );
                }
            }
        });
    }

    fn apply_lobby_metadata(&self, lobby: LobbyId, waiting: bool) {
        let status = if waiting {
            STATUS_WAITING
        } else {
            STATUS_PLAYING
        };
        let host = self.steam_id().to_string();
        // Steam set_lobby_data can fail transiently — retry
        for _ in 0..5 {
            let a = self
                .mm()
                .set_lobby_data(lobby, LOBBY_DATA_GAME, LOBBY_DATA_GAME_VAL);
            let b = self.mm().set_lobby_data(lobby, LOBBY_DATA_STATUS, status);
            let c = self.mm().set_lobby_data(lobby, LOBBY_DATA_MAP, DEFAULT_MAP);
            let d = self.mm().set_lobby_data(lobby, LOBBY_DATA_HOST, &host);
            let e = self
                .mm()
                .set_lobby_data(lobby, LOBBY_DATA_VER, env!("CARGO_PKG_VERSION"));
            let _ = self.mm().set_lobby_joinable(lobby, waiting);
            if a && b && c && d && e {
                return;
            }
            std::thread::sleep(Duration::from_millis(40));
        }
    }

    // ── 3. LOBBY BROWSER / JOIN ───────────────────────────────────

    /// `ISteamMatchmaking::RequestLobbyList` with game + free-slot filters (client-side too).
    ///
    /// Result: `SteamEvent::LobbyList`.
    pub fn request_lobby_list(self: &Arc<Self>, app: AppHandle) {
        if self
            .listing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            Self::emit(
                &app,
                SteamEvent::Error {
                    message: "Lobby list already in progress".into(),
                },
            );
            return;
        }
        let steam = Arc::clone(self);
        let gen = self.op_gen.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::spawn(move || {
            let result = steam.list_lobbies_blocking();
            steam.listing.store(false, Ordering::SeqCst);
            if steam.op_gen.load(Ordering::SeqCst) != gen {
                return; // cancelled / superseded
            }
            match result {
                Ok(lobbies) => {
                    Self::emit(&app, SteamEvent::LobbyList { lobbies });
                }
                Err(e) => {
                    Self::emit(
                        &app,
                        SteamEvent::Error {
                            message: format!("RequestLobbyList failed: {e}"),
                        },
                    );
                    Self::emit(&app, SteamEvent::LobbyList { lobbies: vec![] });
                }
            }
        });
    }

    fn list_lobbies_blocking(&self) -> Result<Vec<LobbyListEntry>, String> {
        let _guard = self
            .mm_lock
            .lock()
            .map_err(|_| "matchmaking lock poisoned".to_string())?;

        // Prefer filtered list; fall back to unfiltered + client filter (Spacewar noise).
        let mut ids = self.request_list_inner(true, true).unwrap_or_default();
        if ids.is_empty() {
            ids = self.request_list_inner(true, false).unwrap_or_default();
        }
        if ids.is_empty() {
            ids = self.request_list_inner(false, false)?;
        }

        let mut out = Vec::new();
        for lobby in ids {
            let mm = self.mm();
            let game = mm.lobby_data(lobby, LOBBY_DATA_GAME).unwrap_or("");
            if game != LOBBY_DATA_GAME_VAL {
                continue;
            }
            let status = mm.lobby_data(lobby, LOBBY_DATA_STATUS).unwrap_or("").to_string();
            if status == STATUS_PLAYING {
                continue;
            }
            let members = mm.lobby_member_count(lobby) as u32;
            if members == 0 || members >= LOBBY_MAX_MEMBERS {
                continue; // full or empty
            }
            let owner = mm.lobby_owner(lobby);
            let owner_id = owner.raw();
            if owner_id == self.steam_id() {
                continue;
            }
            out.push(LobbyListEntry {
                lobby_id: lobby.raw(),
                owner_id,
                owner_name: self.name_of(owner_id),
                members,
                max_members: LOBBY_MAX_MEMBERS,
                map: mm
                    .lobby_data(lobby, LOBBY_DATA_MAP)
                    .unwrap_or(DEFAULT_MAP)
                    .to_string(),
                status,
                version: mm
                    .lobby_data(lobby, LOBBY_DATA_VER)
                    .unwrap_or("")
                    .to_string(),
                ping_ms: None, // not available from list API
            });
        }
        // Prefer fuller? Prefer emptier (1/2) first
        out.sort_by_key(|e| e.members);
        Ok(out)
    }

    fn request_list_inner(
        &self,
        filter_game: bool,
        filter_waiting: bool,
    ) -> Result<Vec<LobbyId>, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        let string_filters = if filter_game {
            let mut v = vec![StringFilter(
                LobbyKey::new(LOBBY_DATA_GAME),
                LOBBY_DATA_GAME_VAL,
                StringFilterKind::Include,
            )];
            if filter_waiting {
                v.push(StringFilter(
                    LobbyKey::new(LOBBY_DATA_STATUS),
                    STATUS_WAITING,
                    StringFilterKind::Include,
                ));
            }
            Some(v)
        } else {
            None
        };

        // NOTE: open_slots filter often returns empty on Spacewar — filter members client-side.
        self.mm()
            .set_lobby_list_filter(LobbyListFilter {
                string: string_filters,
                number: None,
                near_value: None,
                open_slots: None,
                distance: Some(DistanceFilter::Worldwide),
                count: Some(75),
            })
            .request_lobby_list(move |res| {
                let _ = tx.send(res);
            });

        let deadline = Instant::now() + Duration::from_secs(6);
        loop {
            if let Ok(res) = rx.try_recv() {
                return res.map_err(|e| format!("{e:?}"));
            }
            if Instant::now() > deadline {
                return Err("RequestLobbyList timeout".into());
            }
            std::thread::sleep(Duration::from_millis(16));
        }
    }

    /// `ISteamMatchmaking::JoinLobby` — result via `LobbyEntered`.
    pub fn join_lobby(self: &Arc<Self>, app: AppHandle, lobby_id: u64) {
        self.leave_lobby_internal(None);
        self.set_state(
            Some(&app),
            SteamSessionState::JoiningLobby,
            format!("Joining {lobby_id}…"),
        );

        let steam = Arc::clone(self);
        std::thread::spawn(move || {
            let lobby = LobbyId::from_raw(lobby_id);
            let (tx, rx) = std::sync::mpsc::channel();
            steam.mm().join_lobby(lobby, move |res| {
                let _ = tx.send(res);
            });

            let deadline = Instant::now() + Duration::from_secs(10);
            let result = loop {
                if let Ok(res) = rx.try_recv() {
                    break res;
                }
                if Instant::now() > deadline {
                    steam.set_state(
                        Some(&app),
                        SteamSessionState::Error,
                        "JoinLobby timeout",
                    );
                    Self::emit(
                        &app,
                        SteamEvent::LobbyEntered {
                            lobby_id,
                            success: false,
                            is_host: false,
                            error: Some("timeout (lobby gone or network)".into()),
                        },
                    );
                    return;
                }
                std::thread::sleep(Duration::from_millis(16));
            };

            match result {
                Ok(lid) => {
                    let owner = steam.mm().lobby_owner(lid).raw();
                    let me = steam.steam_id();
                    let is_host = owner == me;
                    steam.on_entered_lobby(&app, lid, is_host, owner);
                }
                Err(()) => {
                    steam.set_state(
                        Some(&app),
                        SteamSessionState::Error,
                        "JoinLobby failed (full / gone / denied)",
                    );
                    Self::emit(
                        &app,
                        SteamEvent::LobbyEntered {
                            lobby_id,
                            success: false,
                            is_host: false,
                            error: Some("Join failed — lobby full, deleted, or denied".into()),
                        },
                    );
                }
            }
        });
    }

    fn on_entered_lobby(&self, app: &AppHandle, lid: LobbyId, is_host: bool, owner: u64) {
        let id = lid.raw();
        let me = self.steam_id();
        let me_name = self.persona_name();
        if is_host {
            self.apply_lobby_metadata(lid, true);
        }

        let members = self.collect_members(lid);
        let peer = members.iter().find(|m| !m.is_local).cloned();

        if let Ok(mut inner) = self.inner.lock() {
            inner.lobby_id = Some(id);
            inner.is_host = is_host;
            inner.state = if is_host {
                SteamSessionState::HostingLobby
            } else {
                SteamSessionState::InLobby
            };
            inner.members = members.clone();
            inner.last_member_ids = members.iter().map(|m| m.steam_id).collect();
            if let Some(p) = &peer {
                inner.peer_id = Some(p.steam_id);
                inner.peer_name = p.name.clone();
            } else {
                inner.peer_id = if !is_host { Some(owner) } else { None };
                inner.peer_name = if !is_host {
                    self.name_of(owner)
                } else {
                    String::new()
                };
            }
            inner.handshake_ok = false;
            inner.local_name = me_name;
            inner.detail = format!("In lobby {id}");
        }

        let _ = self.client.friends().set_rich_presence(
            "status",
            Some(if is_host {
                "Hosting DUSTLINE"
            } else {
                "In DUSTLINE lobby"
            }),
        );
        let _ = self.client.friends().set_rich_presence(
            "connect",
            Some(&format!("+connect_lobby {id}")),
        );

        Self::emit(
            app,
            SteamEvent::LobbyEntered {
                lobby_id: id,
                success: true,
                is_host,
                error: None,
            },
        );
        self.set_state(
            Some(app),
            if is_host {
                SteamSessionState::HostingLobby
            } else {
                SteamSessionState::InLobby
            },
            format!("In lobby {id}"),
        );
        self.emit_members(app);

        // If already 2 players (join into waiting host), start handshake
        if members.len() >= 2 {
            self.begin_handshake(app);
        }

        let _ = me;
    }

    fn collect_members(&self, lid: LobbyId) -> Vec<LobbyMember> {
        let me = self.steam_id();
        let owner = self.mm().lobby_owner(lid).raw();
        self.mm()
            .lobby_members(lid)
            .into_iter()
            .map(|s| {
                let id = s.raw();
                LobbyMember {
                    steam_id: id,
                    name: self.name_of(id),
                    is_host: id == owner,
                    is_local: id == me,
                }
            })
            .collect()
    }

    fn emit_members(&self, app: &AppHandle) {
        let (id, members) = self
            .inner
            .lock()
            .map(|i| (i.lobby_id.unwrap_or(0), i.members.clone()))
            .unwrap_or((0, vec![]));
        Self::emit(
            app,
            SteamEvent::LobbyMembers {
                lobby_id: id,
                members,
            },
        );
    }

    /// Leave current lobby. Host leave → lobby ends for 1v1 (no migration).
    pub fn leave_lobby(&self, app: &AppHandle) {
        self.leave_lobby_internal(Some(app));
    }

    fn leave_lobby_internal(&self, app: Option<&AppHandle>) {
        self.op_gen.fetch_add(1, Ordering::SeqCst);
        let id = self.inner.lock().ok().and_then(|i| i.lobby_id);
        if let Some(id) = id {
            self.mm().leave_lobby(LobbyId::from_raw(id));
        }
        let _ = self.client.friends().set_rich_presence("status", None);
        let _ = self.client.friends().set_rich_presence("connect", None);
        if let Ok(mut inner) = self.inner.lock() {
            *inner = ManagerInner::new(inner.local_id, inner.local_name.clone());
        }
        if let Some(app) = app {
            Self::emit(
                app,
                SteamEvent::LobbyClosed {
                    reason: "left".into(),
                },
            );
            self.set_state(Some(app), SteamSessionState::Idle, "Left lobby");
        }
    }

    // ── 4. LOBBY EVENTS (polled) ──────────────────────────────────

    /// Call regularly (~10 Hz). Detects join/leave via member list diff
    /// (LobbyChatUpdate_t equivalent using steamworks-rs member queries).
    pub fn tick_lobby(&self, app: &AppHandle) {
        let lobby_id = match self.inner.lock().ok().and_then(|i| i.lobby_id) {
            Some(id) => id,
            None => return,
        };
        let lid = LobbyId::from_raw(lobby_id);
        let members = self.collect_members(lid);
        let current_ids: HashSet<u64> = members.iter().map(|m| m.steam_id).collect();

        let (prev_ids, was_host, local) = self
            .inner
            .lock()
            .map(|i| {
                (
                    i.last_member_ids.clone(),
                    i.is_host,
                    i.local_id,
                )
            })
            .unwrap_or_default();

        // Joins
        for m in &members {
            if !prev_ids.contains(&m.steam_id) && m.steam_id != local {
                Self::emit(
                    app,
                    SteamEvent::MemberJoined {
                        steam_id: m.steam_id,
                        name: m.name.clone(),
                    },
                );
            }
        }
        // Leaves
        for id in &prev_ids {
            if !current_ids.contains(id) && *id != local {
                let name = self.name_of(*id);
                Self::emit(
                    app,
                    SteamEvent::MemberLeft {
                        steam_id: *id,
                        name,
                    },
                );
            }
        }

        // Host left / lobby empty while we are guest → close
        let owner = self.mm().lobby_owner(lid).raw();
        if !was_host && owner != 0 && owner != self
            .inner
            .lock()
            .map(|i| i.peer_id.unwrap_or(owner))
            .unwrap_or(owner)
        {
            // owner changed — for 1v1 we just end
        }
        if members.len() < 2 && was_host {
            // still hosting alone — ok
        }
        if members.is_empty()
            || (members.len() == 1 && !members[0].is_local && !was_host)
        {
            // We alone as guest? shouldn't happen long
        }

        // Peer left after we had 2 → 1v1 ends
        let had_two = prev_ids.len() >= 2;
        if had_two && members.len() < 2 {
            let st = self.state();
            if matches!(
                st,
                SteamSessionState::Connecting | SteamSessionState::InGame | SteamSessionState::InLobby | SteamSessionState::HostingLobby
            ) {
                Self::emit(
                    app,
                    SteamEvent::LobbyClosed {
                        reason: "peer_left".into(),
                    },
                );
                // Host: keep lobby open for requeue; guest: leave
                if was_host {
                    if let Ok(mut inner) = self.inner.lock() {
                        inner.peer_id = None;
                        inner.peer_name.clear();
                        inner.handshake_ok = false;
                        inner.state = SteamSessionState::HostingLobby;
                        inner.members = members.clone();
                        inner.last_member_ids = current_ids.clone();
                        self.apply_lobby_metadata(lid, true);
                    }
                    self.set_state(Some(app), SteamSessionState::HostingLobby, "Opponent left");
                    let _ = app.emit("opponent_left", serde_json::json!({ "reason": "left" }));
                } else {
                    self.leave_lobby(app);
                    let _ = app.emit("opponent_left", serde_json::json!({ "reason": "host_left" }));
                }
                return;
            }
        }

        // Update member cache
        let peer = members.iter().find(|m| !m.is_local).cloned();
        if let Ok(mut inner) = self.inner.lock() {
            inner.members = members.clone();
            inner.last_member_ids = current_ids;
            if let Some(p) = peer {
                inner.peer_id = Some(p.steam_id);
                inner.peer_name = p.name;
            }
        }
        self.emit_members(app);

        // 2 players → handshake
        if members.len() >= 2 {
            let st = self.state();
            if matches!(
                st,
                SteamSessionState::HostingLobby | SteamSessionState::InLobby
            ) {
                self.begin_handshake(app);
            } else if st == SteamSessionState::Connecting {
                self.tick_handshake(app);
            }
        }
    }

    // ── 5. P2P + HANDSHAKE ────────────────────────────────────────

    fn begin_handshake(&self, app: &AppHandle) {
        let peer = self.inner.lock().ok().and_then(|i| i.peer_id);
        let Some(peer) = peer else {
            return;
        };
        self.set_state(
            Some(app),
            SteamSessionState::Connecting,
            format!("P2P handshake with {}…", self.name_of(peer)),
        );
        if let Ok(mut inner) = self.inner.lock() {
            inner.handshake_ok = false;
            inner.handshake_rtt_ms = None;
            inner.last_ping_ms = 0;
        }
        // Send hello + first ping
        self.send_handshake(
            peer,
            HandshakeMsg {
                kind: "hello".into(),
                tick: 1,
                name: self.persona_name(),
                sent_ms: now_ms(),
            },
        );
        self.send_handshake(
            peer,
            HandshakeMsg {
                kind: "ping".into(),
                tick: 2,
                name: self.persona_name(),
                sent_ms: now_ms(),
            },
        );
        Self::emit(
            app,
            SteamEvent::Handshake {
                peer_id: peer,
                rtt_ms: None,
                ok: false,
                detail: "Handshake ping sent".into(),
            },
        );
    }

    fn tick_handshake(&self, app: &AppHandle) {
        let (peer, ok, last_ping) = self
            .inner
            .lock()
            .map(|i| (i.peer_id, i.handshake_ok, i.last_ping_ms))
            .unwrap_or((None, false, 0));
        let Some(peer) = peer else {
            return;
        };
        if ok {
            return;
        }
        let now = now_ms();
        // Re-ping every 500ms until ok
        if last_ping == 0 || now.saturating_sub(last_ping) >= 500 {
            if let Ok(mut inner) = self.inner.lock() {
                inner.last_ping_ms = now;
            }
            self.send_handshake(
                peer,
                HandshakeMsg {
                    kind: "ping".into(),
                    tick: now,
                    name: self.persona_name(),
                    sent_ms: now,
                },
            );
        }
        // Timeout → still allow match after 4s (relay may be slow)
        if last_ping > 0 && now.saturating_sub(last_ping) > 4000 {
            self.mark_handshake_ok(app, peer, None, "Handshake timeout — continuing via relay");
        }
    }

    fn mark_handshake_ok(
        &self,
        app: &AppHandle,
        peer: u64,
        rtt: Option<u32>,
        detail: impl Into<String>,
    ) {
        let detail = detail.into();
        let (is_host, peer_name) = self
            .inner
            .lock()
            .map(|mut i| {
                i.handshake_ok = true;
                i.handshake_rtt_ms = rtt;
                i.state = SteamSessionState::InGame;
                (i.is_host, i.peer_name.clone())
            })
            .unwrap_or((false, String::new()));

        // Mark lobby playing if host
        if is_host {
            if let Some(id) = self.lobby_id() {
                let lid = LobbyId::from_raw(id);
                let _ = self.mm().set_lobby_data(lid, LOBBY_DATA_STATUS, STATUS_PLAYING);
                let _ = self.mm().set_lobby_joinable(lid, false);
            }
        }

        Self::emit(
            app,
            SteamEvent::Handshake {
                peer_id: peer,
                rtt_ms: rtt,
                ok: true,
                detail: detail.clone(),
            },
        );
        self.set_state(Some(app), SteamSessionState::InGame, detail);
        Self::emit(
            app,
            SteamEvent::MatchReady {
                is_host,
                peer_id: peer,
                peer_name,
            },
        );
    }

    fn send_handshake(&self, peer: u64, msg: HandshakeMsg) {
        if let Ok(bytes) = serde_json::to_vec(&msg) {
            self.send_raw(peer, CH_HANDSHAKE, &bytes, true);
        }
    }

    /// Send on Networking Messages (RELIABLE or UNRELIABLE).
    pub fn send_raw(&self, peer: u64, channel: u32, bytes: &[u8], reliable: bool) {
        let identity = NetworkingIdentity::new_steam_id(SteamId::from_raw(peer));
        let flags = if reliable {
            SendFlags::RELIABLE_NO_NAGLE
        } else {
            SendFlags::UNRELIABLE_NO_NAGLE
        };
        let _ = self
            .client
            .networking_messages()
            .send_message_to_user(identity, flags, bytes, channel);
    }

    /// Pump Networking Messages; handle handshake channel; return other packets.
    pub fn pump_messages(&self, app: &AppHandle) -> Vec<(u64, u32, Vec<u8>)> {
        let mut other = Vec::new();
        for ch in 0..CHANNEL_COUNT {
            let messages = self
                .client
                .networking_messages()
                .receive_messages_on_channel(ch, 32);
            for msg in messages {
                let from = msg
                    .identity_peer()
                    .steam_id()
                    .map(|s| s.raw())
                    .unwrap_or(0);
                let data = msg.data().to_vec();
                if ch == CH_HANDSHAKE {
                    self.on_handshake_packet(app, from, &data);
                } else {
                    other.push((from, ch, data));
                }
            }
        }
        other
    }

    fn on_handshake_packet(&self, app: &AppHandle, from: u64, data: &[u8]) {
        let Ok(msg) = serde_json::from_slice::<HandshakeMsg>(data) else {
            return;
        };
        // Remember peer name
        if !msg.name.is_empty() {
            if let Ok(mut inner) = self.inner.lock() {
                if inner.peer_id.is_none() {
                    inner.peer_id = Some(from);
                }
                if inner.peer_name.is_empty() {
                    inner.peer_name = msg.name.clone();
                }
            }
        }
        match msg.kind.as_str() {
            "hello" => {
                // Reply hello + ping
                self.send_handshake(
                    from,
                    HandshakeMsg {
                        kind: "hello".into(),
                        tick: msg.tick + 1,
                        name: self.persona_name(),
                        sent_ms: now_ms(),
                    },
                );
            }
            "ping" => {
                self.send_handshake(
                    from,
                    HandshakeMsg {
                        kind: "pong".into(),
                        tick: msg.tick,
                        name: self.persona_name(),
                        sent_ms: msg.sent_ms,
                    },
                );
            }
            "pong" => {
                let rtt = now_ms().saturating_sub(msg.sent_ms) as u32;
                self.mark_handshake_ok(
                    app,
                    from,
                    Some(rtt),
                    format!("Handshake OK · RTT {rtt} ms"),
                );
            }
            _ => {}
        }
    }

    // ── Friend invite callback registration ───────────────────────

    /// Register `GameLobbyJoinRequested` (friend invite / overlay join).
    pub fn register_invite_callback(self: &Arc<Self>, app: AppHandle) {
        let steam = Arc::clone(self);
        let handle = self.client.register_callback(move |ev: GameLobbyJoinRequested| {
            let id = ev.lobby_steam_id.raw();
            eprintln!("[SteamNetworkManager] invite join lobby={id}");
            steam.join_lobby(app.clone(), id);
        });
        // Keep registered for process lifetime
        std::mem::forget(handle);
    }

    /// Open Steam invite dialog for current lobby (host).
    pub fn activate_invite_dialog(&self) -> Result<String, String> {
        let id = self
            .lobby_id()
            .ok_or_else(|| "No lobby — create or join first".to_string())?;
        let lobby = LobbyId::from_raw(id);
        let _ = self.mm().set_lobby_joinable(lobby, true);
        self.apply_lobby_metadata(lobby, true);
        self.client.friends().activate_invite_dialog(lobby);
        Ok(format!("Invite dialog for lobby {id}"))
    }

    /// Silent leave (no AppHandle required) — for workers / cancel.
    pub fn leave_lobby_silent(&self) {
        self.leave_lobby_internal(None);
    }

    /// Blocking lobby list for auto-queue workers.
    pub fn list_lobbies_blocking_pub(&self) -> Result<Vec<LobbyListEntry>, String> {
        self.list_lobbies_blocking()
    }

    /// Blocking create — returns true on success.
    pub fn create_lobby_blocking(&self, visibility: LobbyVisibility) -> bool {
        self.leave_lobby_silent();
        let lobby_type = visibility.to_steam();
        let (tx, rx) = std::sync::mpsc::channel();
        self.mm()
            .create_lobby(lobby_type, LOBBY_MAX_MEMBERS, move |res| {
                let _ = tx.send(res);
            });
        let deadline = Instant::now() + Duration::from_secs(12);
        let lid = loop {
            if let Ok(res) = rx.try_recv() {
                match res {
                    Ok(id) => break id,
                    Err(_) => return false,
                }
            }
            if Instant::now() > deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(16));
        };
        self.apply_lobby_metadata(lid, true);
        let id = lid.raw();
        let me = self.steam_id();
        let me_name = self.persona_name();
        if let Ok(mut inner) = self.inner.lock() {
            inner.lobby_id = Some(id);
            inner.is_host = true;
            inner.state = SteamSessionState::HostingLobby;
            inner.peer_id = None;
            inner.peer_name.clear();
            inner.handshake_ok = false;
            inner.members = vec![LobbyMember {
                steam_id: me,
                name: me_name,
                is_host: true,
                is_local: true,
            }];
            inner.last_member_ids = HashSet::from([me]);
            inner.detail = format!("Hosting lobby {id}");
        }
        let _ = self
            .client
            .friends()
            .set_rich_presence("status", Some("Hosting DUSTLINE lobby"));
        let _ = self
            .client
            .friends()
            .set_rich_presence("connect", Some(&format!("+connect_lobby {id}")));
        true
    }

    /// Blocking join — returns true on success.
    pub fn join_lobby_blocking(&self, lobby_id: u64) -> bool {
        self.leave_lobby_silent();
        let lobby = LobbyId::from_raw(lobby_id);
        let (tx, rx) = std::sync::mpsc::channel();
        self.mm().join_lobby(lobby, move |res| {
            let _ = tx.send(res);
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        let lid = loop {
            if let Ok(res) = rx.try_recv() {
                match res {
                    Ok(id) => break id,
                    Err(()) => return false,
                }
            }
            if Instant::now() > deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(16));
        };
        let owner = self.mm().lobby_owner(lid).raw();
        let me = self.steam_id();
        // Minimal AppHandle-less enter
        let is_host = owner == me;
        if is_host {
            self.apply_lobby_metadata(lid, true);
        }
        let members = self.collect_members(lid);
        let peer = members.iter().find(|m| !m.is_local).cloned();
        if let Ok(mut inner) = self.inner.lock() {
            inner.lobby_id = Some(lid.raw());
            inner.is_host = is_host;
            inner.state = if is_host {
                SteamSessionState::HostingLobby
            } else {
                SteamSessionState::InLobby
            };
            inner.members = members;
            inner.last_member_ids = inner.members.iter().map(|m| m.steam_id).collect();
            if let Some(p) = peer {
                inner.peer_id = Some(p.steam_id);
                inner.peer_name = p.name;
            } else if !is_host {
                inner.peer_id = Some(owner);
                inner.peer_name = self.name_of(owner);
            }
            inner.handshake_ok = false;
            inner.detail = format!("In lobby {}", lid.raw());
        }
        let _ = self.client.friends().set_rich_presence(
            "connect",
            Some(&format!("+connect_lobby {}", lid.raw())),
        );
        true
    }

    pub fn emit_ui_snap(mgr: &SteamNetworkManager, app: &AppHandle) {
        let snap = mgr.ui_snapshot();
        let _ = app.emit("lobby_state", &snap);
        if let Some(status) = snap.get("status").and_then(|v| v.as_str()) {
            let _ = app.emit("steam_status", status.to_string());
        }
    }

    /// Snapshot for UI (compatible fields for lobby screen).
    pub fn ui_snapshot(&self) -> serde_json::Value {
        let inner = self.inner.lock().ok();
        let (state, lobby_id, is_host, you, peer, members, handshake, rtt, detail) =
            if let Some(i) = inner.as_ref() {
                (
                    i.state,
                    i.lobby_id,
                    i.is_host,
                    i.local_name.clone(),
                    i.peer_name.clone(),
                    i.members.len() as u8,
                    i.handshake_ok,
                    i.handshake_rtt_ms,
                    i.detail.clone(),
                )
            } else {
                (
                    SteamSessionState::Idle,
                    None,
                    false,
                    String::new(),
                    String::new(),
                    0,
                    false,
                    None,
                    String::new(),
                )
            };

        let phase = match state {
            SteamSessionState::Idle => "idle",
            SteamSessionState::CreatingLobby | SteamSessionState::JoiningLobby => "searching",
            SteamSessionState::HostingLobby => "hosting",
            SteamSessionState::InLobby => "joined",
            SteamSessionState::Connecting => "ready",
            SteamSessionState::InGame => {
                if handshake {
                    "live"
                } else {
                    "starting"
                }
            }
            SteamSessionState::Error => "error",
        };

        serde_json::json!({
            "phase": phase,
            "state": state,
            "members": members,
            "is_host": is_host,
            "lobby_id": lobby_id,
            "you": you,
            "peer": peer,
            "peer_ready": handshake || members >= 2,
            "status": detail,
            "can_invite": lobby_id.is_some() && members < 2 && matches!(
                state,
                SteamSessionState::HostingLobby | SteamSessionState::InLobby
            ),
            "format": "Best of 5 · first to 3",
            "handshake_ok": handshake,
            "rtt_ms": rtt,
        })
    }
}
