//! Steamworks P2P + Quick Matchmaking (public lobbies).
//! When two players search, they share a lobby and the match auto-starts.
//!
//! Design notes:
//! - Lower SteamID creates earlier; higher IDs search longer then may create.
//! - Create runs as soon as create_gate elapses (not after a fixed attempt count).
//! - Solo merge: prefer lower owner; after STUCK_MS join ANY other solo lobby.
//! - Only one create at a time (`creating` flag); list ops under `mm_lock`.
//! - Relay network access enabled so P2P works across NAT.
//! - In-match network pump is 1ms; matchmaking poll stays slower.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use steamworks::networking_types::{NetworkingIdentity, SendFlags};
use steamworks::{
    Client, DistanceFilter, GameLobbyJoinRequested, LobbyId, LobbyKey, LobbyListFilter, LobbyType,
    SteamId, StringFilter, StringFilterKind,
};
use tauri::{AppHandle, Emitter};

use crate::network::{
    ClientInput, NetworkEvent, SharedGameState, CHANNEL_EVENTS, CHANNEL_INPUT, CHANNEL_STATE,
    LOBBY_KEY_GAME, LOBBY_KEY_STATUS, LOBBY_VAL_GAME, LOBBY_VAL_PLAYING, LOBBY_VAL_WAITING,
};

const CHANNEL_COUNT: u32 = 4;
/// How often a solo player re-scans for other waiting lobbies.
const RESCAN_MS: u64 = 400;
/// After this solo time, join ANY other DUSTLINE solo lobby (heal dual-create splits).
const STUCK_MERGE_MS: u64 = 1_800;
/// If still alone this long, leave lobby and re-queue (nuclear heal).
const SOLO_REQUEUE_MS: u64 = 9_000;
/// Max time to search before hard create (even high steam ids).
const HARD_CREATE_MS: u64 = 22_000;
/// Prefer starting only after peer Hello; after this, start anyway.
const HELLO_WAIT_MS: u64 = 10_000;
/// Minimum time with 2 lobby members before start (session warm-up).
const MIN_READY_MS: u64 = 600;
/// Retransmit GameStart until client acks (not only during countdown).
const GAME_START_RETRY_MS: u64 = 350;
/// Keep retransmitting GameStart this long after first send.
const GAME_START_RETRY_WINDOW_MS: u64 = 25_000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub struct SteamRuntime {
    pub client: Client,
    /// Monotonic token so cancelled queues don't apply stale results.
    search_gen: AtomicU64,
    /// Prevents parallel create_lobby from find-thread + ensure_queue_lobby.
    creating: AtomicBool,
    /// Steam only allows one lobby list / matchmaking op at a time.
    mm_lock: Mutex<()>,
}

impl SteamRuntime {
    pub fn try_init() -> Result<Self, String> {
        let (client, single) = Client::init().map_err(|e| {
            format!(
                "Steam init failed: {:?}. Start the Steam client, stay logged in, and keep steam_appid.txt next to the exe.",
                e
            )
        })?;

        // Required for Steam Networking Messages through NAT / internet.
        client.networking_utils().init_relay_network_access();

        client
            .networking_messages()
            .session_request_callback(|request| {
                request.accept();
            });

        std::thread::spawn(move || loop {
            single.run_callbacks();
            std::thread::sleep(Duration::from_millis(5));
        });

        Ok(Self {
            client,
            search_gen: AtomicU64::new(0),
            creating: AtomicBool::new(false),
            mm_lock: Mutex::new(()),
        })
    }

    pub fn steam_id(&self) -> u64 {
        self.client.user().steam_id().raw()
    }

    pub fn persona_name(&self) -> String {
        self.client.friends().name()
    }

    fn mm(&self) -> steamworks::Matchmaking<steamworks::ClientManager> {
        self.client.matchmaking()
    }

    fn set_status(shared: &SharedGameState, status: impl Into<String>) {
        if let Ok(mut net) = shared.network_manager.lock() {
            net.status = status.into();
        }
    }

    /// Leave current lobby if any (no error if none).
    pub fn leave_current_lobby(&self, shared: &SharedGameState) {
        self.search_gen.fetch_add(1, Ordering::SeqCst);
        self.creating.store(false, Ordering::SeqCst);
        if let Ok(mut net) = shared.network_manager.lock() {
            if let Some(id) = net.lobby_id.take() {
                self.mm().leave_lobby(LobbyId::from_raw(id));
            }
            net.searching = false;
            net.remote_steam_id = None;
            net.connected = false;
            net.is_host = false;
            net.local_player_id = 0;
            net.status = "Left matchmaking".into();
            net.reset_match_flags();
        }
    }

    /// Quick match entry: kicks off background search/create. Returns immediately.
    pub fn find_match(self: &Arc<Self>, shared: Arc<SharedGameState>) -> Result<String, String> {
        // Cancel previous queue + leave lobby
        self.leave_current_lobby(&shared);

        let gen = self.search_gen.fetch_add(1, Ordering::SeqCst) + 1;

        {
            let mut net = shared
                .network_manager
                .lock()
                .map_err(|e| e.to_string())?;
            net.steam_ready = true;
            net.searching = true;
            net.match_started = false;
            net.remote_steam_id = None;
            net.lobby_id = None;
            net.connected = false;
            net.is_host = false;
            net.status = "Searching for opponent…".into();
        }

        let steam = Arc::clone(self);
        let shared2 = Arc::clone(&shared);
        std::thread::spawn(move || {
            // Deterministic stagger: lower sid ranks create earlier so higher ranks
            // keep searching and can join them (heals simultaneous dual-create).
            let sid = steam.steam_id();
            let rank = sid % 20; // 0..19
            // rank 0 → ~2.0s, rank 19 → ~13.4s
            let create_gate_ms = 2_000 + rank * 600;
            if let Err(e) = steam.run_find_match(shared2, gen, create_gate_ms) {
                eprintln!("matchmaking error: {e}");
            }
        });

        Ok(format!(
            "Queue started as {} — searching worldwide…",
            self.persona_name()
        ))
    }

    fn run_find_match(
        &self,
        shared: Arc<SharedGameState>,
        gen: u64,
        create_gate_ms: u64,
    ) -> Result<(), String> {
        let started = Instant::now();
        let mut attempt: u32 = 0;

        // Search until we join OR create_gate elapses (then create immediately).
        loop {
            if self.search_gen.load(Ordering::SeqCst) != gen {
                return Ok(());
            }
            // Already in a lobby (merge / ensure_queue may have filled it)
            if shared
                .network_manager
                .lock()
                .map(|n| n.lobby_id.is_some())
                .unwrap_or(false)
            {
                return Ok(());
            }

            attempt += 1;
            let elapsed = started.elapsed().as_millis() as u64;
            Self::set_status(
                &shared,
                format!(
                    "Searching for player… #{attempt} · create in {}s",
                    create_gate_ms.saturating_sub(elapsed) / 1000
                ),
            );

            match self.try_join_best_open_lobby(Arc::clone(&shared), None) {
                Ok(Some(msg)) => {
                    if self.search_gen.load(Ordering::SeqCst) == gen {
                        Self::set_status(&shared, msg);
                    }
                    return Ok(());
                }
                Ok(None) => {}
                Err(e) => {
                    eprintln!("lobby list/join error: {e}");
                    Self::set_status(&shared, format!("Search error — retry… ({e})"));
                }
            }

            let elapsed = started.elapsed().as_millis() as u64;

            // Create as soon as gate elapses (staggered by steam id rank).
            if elapsed >= create_gate_ms || elapsed >= HARD_CREATE_MS {
                if self.search_gen.load(Ordering::SeqCst) != gen {
                    return Ok(());
                }
                // Several last-chance joins (Steam list is laggy right after peer creates)
                for _ in 0..3 {
                    if let Ok(Some(msg)) = self.try_join_best_open_lobby(Arc::clone(&shared), None)
                    {
                        if self.search_gen.load(Ordering::SeqCst) == gen {
                            Self::set_status(&shared, msg);
                        }
                        return Ok(());
                    }
                    std::thread::sleep(Duration::from_millis(350));
                    if self.search_gen.load(Ordering::SeqCst) != gen {
                        return Ok(());
                    }
                }
                Self::set_status(&shared, "No lobby found — creating public queue…");
                let msg = self.create_waiting_lobby(Arc::clone(&shared))?;
                if self.search_gen.load(Ordering::SeqCst) == gen {
                    Self::set_status(&shared, msg);
                }
                // After create: keep hunting peers to merge into (dual-create heal)
                self.post_create_merge_hunt(Arc::clone(&shared), gen);
                return Ok(());
            }

            // Fast poll while searching — Steam lobby index lags 1–5s
            let wait = (create_gate_ms - elapsed).min(450).max(180);
            std::thread::sleep(Duration::from_millis(wait));
        }
    }

    /// After we create a solo lobby, keep trying to find+join another DUSTLINE lobby
    /// so two simultaneous creators still meet.
    fn post_create_merge_hunt(&self, shared: Arc<SharedGameState>, gen: u64) {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(12) {
            if self.search_gen.load(Ordering::SeqCst) != gen {
                return;
            }
            let (lobby, searching, started_match) = shared
                .network_manager
                .lock()
                .map(|n| (n.lobby_id, n.searching, n.match_started))
                .unwrap_or((None, false, true));
            if !searching || started_match {
                return;
            }
            let Some(our) = lobby else {
                return;
            };
            // members already 2? host poll will start the match
            let members = self
                .mm()
                .lobby_member_count(LobbyId::from_raw(our));
            if members >= 2 {
                return;
            }
            self.tag_waiting_lobby(LobbyId::from_raw(our));
            // Force stuck-style merge: join ANY other solo DUSTLINE lobby
            if let Ok(lobbies) = self.request_open_lobbies() {
                let me = self.steam_id();
                let others = self.collect_join_candidates(&lobbies, Some(our), me);
                if let Some((target, owner_id)) = others.first().copied() {
                    // Prefer lower owner; after 1.5s of this hunt join anyone
                    let force = started.elapsed() >= Duration::from_millis(1_500);
                    if owner_id < me || force {
                        eprintln!(
                            "post_create merge → lobby {} owner {} force={force}",
                            target.raw(),
                            owner_id
                        );
                        self.mm().leave_lobby(LobbyId::from_raw(our));
                        if let Ok(lobby_id) = self.join_lobby_raw(target) {
                            let owner = self.mm().lobby_owner(lobby_id);
                            if let Ok(mut net) = shared.network_manager.lock() {
                                net.is_host = false;
                                net.local_player_id = 1;
                                net.lobby_id = Some(lobby_id.raw());
                                net.remote_steam_id = Some(owner.raw());
                                net.connected = true;
                                net.searching = true;
                                net.reset_match_flags();
                                net.status = format!(
                                    "Merged into lobby {} — waiting for start…",
                                    lobby_id.raw()
                                );
                            }
                            if let Ok(mut game) = shared.game_state.lock() {
                                *game = crate::game::state::GameState::new();
                                game.add_player(0);
                                game.add_player(1);
                            }
                            let (primary, skin, hat) = shared
                                .network_manager
                                .lock()
                                .map(|n| {
                                    (
                                        n.local_primary.clone(),
                                        n.local_skin.clone(),
                                        n.local_hat.clone(),
                                    )
                                })
                                .unwrap_or(("AR".into(), "default".into(), "none".into()));
                            self.send_event(
                                owner,
                                &NetworkEvent::Hello {
                                    player_id: 1,
                                    primary,
                                    skin,
                                    hat,
                                },
                            );
                            return;
                        } else if let Ok(mut net) = shared.network_manager.lock() {
                            net.lobby_id = None;
                            net.searching = true;
                        }
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(450));
        }
    }

    /// Collect joinable solo waiting lobbies (not owned by us, not full, not playing).
    /// Returns (lobby, owner_steam_id) sorted by canonical order: lower owner id first, then lower lobby id.
    fn collect_join_candidates(
        &self,
        lobbies: &[LobbyId],
        skip_lobby: Option<u64>,
        me: u64,
    ) -> Vec<(LobbyId, u64)> {
        let mut candidates: Vec<(LobbyId, u64)> = Vec::new();
        for &lobby in lobbies {
            if skip_lobby == Some(lobby.raw()) {
                continue;
            }
            let mm = self.mm();

            // Strict DUSTLINE tag only (never join empty/unrelated AppID-480 lobbies)
            let game = mm.lobby_data(lobby, LOBBY_KEY_GAME).unwrap_or("");
            if game != LOBBY_VAL_GAME {
                continue;
            }

            let status = mm.lobby_data(lobby, LOBBY_KEY_STATUS).unwrap_or("");
            // Accept waiting / empty status (metadata lag). Only skip active matches.
            if status == LOBBY_VAL_PLAYING {
                continue;
            }

            let members = mm.lobby_member_count(lobby);
            // Solo waiting only (1). members==0 can happen briefly — skip.
            if members != 1 {
                continue;
            }

            let owner = mm.lobby_owner(lobby).raw();
            if owner == me || owner == 0 {
                continue;
            }
            candidates.push((lobby, owner));
        }
        // Canonical host = lowest owner steam id, then lowest lobby id
        candidates.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.raw().cmp(&b.0.raw())));
        candidates
    }

    /// Join the best open DUSTLINE lobby (canonical = highest Steam lobby id).
    /// Optionally skip our current lobby.
    fn try_join_best_open_lobby(
        &self,
        shared: Arc<SharedGameState>,
        skip_lobby: Option<u64>,
    ) -> Result<Option<String>, String> {
        let lobbies = self.request_open_lobbies()?;
        let me = self.steam_id();
        let candidates = self.collect_join_candidates(&lobbies, skip_lobby, me);

        if candidates.is_empty() {
            eprintln!("matchmaking: list={} candidates=0", lobbies.len());
            return Ok(None);
        }

        eprintln!(
            "matchmaking: list={} candidates={} best_owner={} best_lobby={}",
            lobbies.len(),
            candidates.len(),
            candidates[0].1,
            candidates[0].0.raw()
        );

        for (lobby, _) in candidates {
            match self.join_lobby_raw(lobby) {
                Ok(lobby_id) => {
                    let owner = self.mm().lobby_owner(lobby_id);
                    let (primary, skin, hat) = {
                        let mut net = shared.network_manager.lock().map_err(|e| e.to_string())?;
                        // Cancelled / left queue while join was in flight
                        if !net.searching {
                            self.mm().leave_lobby(lobby_id);
                            return Ok(None);
                        }
                        net.is_host = false;
                        net.local_player_id = 1;
                        net.lobby_id = Some(lobby_id.raw());
                        net.remote_steam_id = Some(owner.raw());
                        net.connected = true;
                        net.searching = true;
                        net.match_started = false;
                        net.steam_ready = true;
                        net.status = format!("Joined lobby {} — waiting…", lobby_id.raw());
                        (
                            net.local_primary.clone(),
                            net.local_skin.clone(),
                            net.local_hat.clone(),
                        )
                    };
                    {
                        let mut game = shared.game_state.lock().map_err(|e| e.to_string())?;
                        *game = crate::game::state::GameState::new();
                        game.add_player(0);
                        game.add_player(1);
                        let wt = crate::game::weapons::WeaponType::from_str_loose(&primary);
                        game.set_player_loadout(1, wt, &skin, &hat);
                    }
                    self.send_event(
                        owner,
                        &NetworkEvent::Hello {
                            player_id: 1,
                            primary,
                            skin,
                            hat,
                        },
                    );
                    return Ok(Some(format!(
                        "Joined lobby {} — waiting for match start…",
                        lobby_id.raw()
                    )));
                }
                Err(_) => continue,
            }
        }
        Ok(None)
    }

    /// Multi-strategy lobby discovery. Steam string filters lag; we UNION strategies.
    /// Never return early on a non-empty list that has zero joinable DUSTLINE lobbies.
    /// Serialized: concurrent RequestLobbyList cancels previous requests on Steam.
    fn request_open_lobbies(&self) -> Result<Vec<LobbyId>, String> {
        let _guard = self
            .mm_lock
            .lock()
            .map_err(|_| "matchmaking lock poisoned".to_string())?;

        use std::collections::HashSet;
        let mut all: Vec<LobbyId> = Vec::new();
        let mut seen: HashSet<u64> = HashSet::new();

        // 1) game=DUSTLINE  2) game+waiting  3) unfiltered (client-side DUSTLINE filter)
        for (fg, fw, name) in [
            (true, false, "game"),
            (true, true, "game+waiting"),
            (false, false, "unfiltered"),
        ] {
            match self.request_lobby_list_inner(fg, fw) {
                Ok(list) => {
                    let before = all.len();
                    for l in list {
                        if seen.insert(l.raw()) {
                            all.push(l);
                        }
                    }
                    eprintln!(
                        "matchmaking: strategy {name} → +{} (union={})",
                        all.len() - before,
                        all.len()
                    );
                    // Fast path: if we already have a joinable DUSTLINE solo lobby, stop
                    let me = self.steam_id();
                    if self
                        .collect_join_candidates(&all, None, me)
                        .first()
                        .is_some()
                    {
                        return Ok(all);
                    }
                }
                Err(e) => eprintln!("matchmaking: strategy {name} err: {e}"),
            }
        }
        eprintln!("matchmaking: union total → {} lobbies", all.len());
        Ok(all)
    }

    fn request_lobby_list_inner(
        &self,
        filter_game: bool,
        filter_waiting: bool,
    ) -> Result<Vec<LobbyId>, String> {
        let (tx, rx) = std::sync::mpsc::channel();

        let string_filters = if filter_game {
            let mut v = vec![StringFilter(
                LobbyKey::new(LOBBY_KEY_GAME),
                LOBBY_VAL_GAME,
                StringFilterKind::Include,
            )];
            if filter_waiting {
                v.push(StringFilter(
                    LobbyKey::new(LOBBY_KEY_STATUS),
                    LOBBY_VAL_WAITING,
                    StringFilterKind::Include,
                ));
            }
            Some(v)
        } else {
            None
        };

        // NOTE: do NOT set open_slots — it frequently returns empty on Spacewar / laggy metadata.
        self.mm()
            .set_lobby_list_filter(LobbyListFilter {
                string: string_filters,
                number: None,
                near_value: None,
                open_slots: None,
                distance: Some(DistanceFilter::Worldwide),
                count: Some(100),
            })
            .request_lobby_list(move |res| {
                let _ = tx.send(res);
            });

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(res) = rx.try_recv() {
                return res.map_err(|e| format!("Lobby list failed: {:?}", e));
            }
            if Instant::now() > deadline {
                return Err("Lobby search timed out".into());
            }
            std::thread::sleep(Duration::from_millis(16));
        }
    }

    fn join_lobby_raw(&self, lobby: LobbyId) -> Result<LobbyId, ()> {
        // Note: do not hold mm_lock across join — list lock is separate and must release first.
        let (tx, rx) = std::sync::mpsc::channel();
        self.mm().join_lobby(lobby, move |res| {
            let _ = tx.send(res);
        });
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if let Ok(res) = rx.try_recv() {
                return res;
            }
            if Instant::now() > deadline {
                return Err(());
            }
            std::thread::sleep(Duration::from_millis(16));
        }
    }

    fn tag_waiting_lobby(&self, lobby_id: LobbyId) {
        // Steam set_lobby_data can fail transiently — retry a few times.
        for _ in 0..5 {
            let ok_game = self
                .mm()
                .set_lobby_data(lobby_id, LOBBY_KEY_GAME, LOBBY_VAL_GAME);
            let ok_status =
                self.mm()
                    .set_lobby_data(lobby_id, LOBBY_KEY_STATUS, LOBBY_VAL_WAITING);
            let _ = self.mm().set_lobby_joinable(lobby_id, true);
            let _ = self
                .mm()
                .set_lobby_data(lobby_id, "ver", env!("CARGO_PKG_VERSION"));
            let _ = self.mm().set_lobby_data(lobby_id, "players", "1");
            if ok_game && ok_status {
                return;
            }
            eprintln!("warning: set_lobby_data retry game={ok_game} status={ok_status}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn create_waiting_lobby(&self, shared: Arc<SharedGameState>) -> Result<String, String> {
        // Serialize creates across threads
        if self
            .creating
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok("Create already in progress…".into());
        }

        // Another search might have filled lobby_id while we waited
        {
            let net = shared.network_manager.lock().map_err(|e| e.to_string())?;
            if net.lobby_id.is_some() {
                self.creating.store(false, Ordering::SeqCst);
                return Ok("Already in a lobby".into());
            }
            if !net.searching {
                self.creating.store(false, Ordering::SeqCst);
                return Ok("Queue cancelled".into());
            }
        }

        // Final list attempt right before create
        if let Ok(Some(msg)) = self.try_join_best_open_lobby(Arc::clone(&shared), None) {
            self.creating.store(false, Ordering::SeqCst);
            return Ok(msg);
        }

        let (tx, rx) = std::sync::mpsc::channel();
        self.mm()
            .create_lobby(LobbyType::Public, 2, move |res| {
                let _ = tx.send(res);
            });

        let deadline = Instant::now() + Duration::from_secs(10);
        let result = loop {
            if let Ok(res) = rx.try_recv() {
                break match res {
                    Ok(lobby_id) => {
                        self.tag_waiting_lobby(lobby_id);

                        {
                            let mut net =
                                shared.network_manager.lock().map_err(|e| e.to_string())?;
                            // Race: someone else already joined a lobby for us
                            if net.lobby_id.is_some() || !net.searching {
                                self.mm().leave_lobby(lobby_id);
                                self.creating.store(false, Ordering::SeqCst);
                                return Ok("Queue already resolved".into());
                            }
                            net.is_host = true;
                            net.local_player_id = 0;
                            net.lobby_id = Some(lobby_id.raw());
                            net.connected = true;
                            net.searching = true;
                            net.match_started = false;
                            net.steam_ready = true;
                            net.remote_steam_id = None;
                            net.status = format!(
                                "In queue (1/2) — lobby {} — waiting…",
                                lobby_id.raw()
                            );
                        }
                        {
                            let mut game = shared.game_state.lock().map_err(|e| e.to_string())?;
                            *game = crate::game::state::GameState::new();
                            game.add_player(0);
                        }

                        Ok(format!(
                            "Lobby open ({}) — waiting for opponent…",
                            lobby_id.raw()
                        ))
                    }
                    Err(e) => Err(format!("Create lobby failed: {:?}", e)),
                };
            }
            if Instant::now() > deadline {
                self.creating.store(false, Ordering::SeqCst);
                return Err("Create lobby timed out — is Steam running?".into());
            }
            std::thread::sleep(Duration::from_millis(16));
        };

        self.creating.store(false, Ordering::SeqCst);
        result
    }

    pub fn cancel_matchmaking(&self, shared: &SharedGameState) -> String {
        self.leave_current_lobby(shared);
        if let Ok(mut game) = shared.game_state.lock() {
            *game = crate::game::state::GameState::new();
        }
        "Matchmaking cancelled".into()
    }

    /// Opens Steam overlay friend-invite dialog for the current lobby.
    pub fn invite_friends(&self, shared: &SharedGameState) -> Result<String, String> {
        let lobby_raw = {
            let net = shared
                .network_manager
                .lock()
                .map_err(|e| e.to_string())?;
            net.lobby_id
        };
        let Some(lobby_raw) = lobby_raw else {
            return Err(
                "No lobby yet — wait until the queue shows a lobby id, then invite.".into(),
            );
        };
        let lobby = LobbyId::from_raw(lobby_raw);
        // Ensure friends can join (host only succeeds)
        let _ = self.mm().set_lobby_joinable(lobby, true);
        self.tag_waiting_lobby(lobby);
        // Rich presence so friends see "In DUSTLINE"
        let _ = self
            .client
            .friends()
            .set_rich_presence("status", Some("In DUSTLINE queue"));
        let _ = self.client.friends().set_rich_presence(
            "connect",
            Some(&format!("+connect_lobby {lobby_raw}")),
        );
        self.client.friends().activate_invite_dialog(lobby);
        Self::set_status(
            shared,
            format!("Invite dialog open — lobby {lobby_raw}"),
        );
        Ok(format!(
            "Steam invite opened for lobby {lobby_raw}. Pick a friend in the overlay."
        ))
    }

    /// Join a lobby from a Steam friend invite / overlay join request.
    pub fn accept_lobby_invite(
        self: &Arc<Self>,
        shared: Arc<SharedGameState>,
        app: &AppHandle,
        lobby: LobbyId,
    ) {
        let steam = Arc::clone(self);
        let app = app.clone();
        std::thread::spawn(move || {
            let gen = steam.search_gen.fetch_add(1, Ordering::SeqCst) + 1;
            // Leave any current queue first (without bumping gen again)
            if let Ok(mut net) = shared.network_manager.lock() {
                if let Some(id) = net.lobby_id.take() {
                    steam.mm().leave_lobby(LobbyId::from_raw(id));
                }
                net.searching = true;
                net.match_started = false;
                net.steam_ready = true;
                net.status = format!("Joining friend lobby {}…", lobby.raw());
            }
            let _ = app.emit(
                "steam_status",
                format!("Joining invite lobby {}…", lobby.raw()),
            );

            match steam.join_lobby_raw(lobby) {
                Ok(lobby_id) => {
                    if steam.search_gen.load(Ordering::SeqCst) != gen {
                        steam.mm().leave_lobby(lobby_id);
                        return;
                    }
                    let owner = steam.mm().lobby_owner(lobby_id);
                    let me = steam.steam_id();
                    let is_host = owner.raw() == me;
                    {
                        if let Ok(mut net) = shared.network_manager.lock() {
                            net.is_host = is_host;
                            net.local_player_id = if is_host { 0 } else { 1 };
                            net.lobby_id = Some(lobby_id.raw());
                            net.remote_steam_id = if is_host {
                                None
                            } else {
                                Some(owner.raw())
                            };
                            net.connected = true;
                            net.searching = true;
                            net.match_started = false;
                            net.steam_ready = true;
                            net.status = format!(
                                "In lobby {} — waiting for match…",
                                lobby_id.raw()
                            );
                        }
                    }
                    {
                        if let Ok(mut game) = shared.game_state.lock() {
                            *game = crate::game::state::GameState::new();
                            game.add_player(0);
                            if !is_host {
                                game.add_player(1);
                            }
                        }
                    }
                    if !is_host {
                        let (primary, skin, hat) = shared
                            .network_manager
                            .lock()
                            .map(|n| {
                                (
                                    n.local_primary.clone(),
                                    n.local_skin.clone(),
                                    n.local_hat.clone(),
                                )
                            })
                            .unwrap_or(("AR".into(), "default".into(), "none".into()));
                        steam.send_event(
                            owner,
                            &NetworkEvent::Hello {
                                player_id: 1,
                                primary,
                                skin,
                                hat,
                            },
                        );
                    }
                    steam.tag_waiting_lobby(lobby_id);
                    let _ = app.emit(
                        "steam_status",
                        format!("Joined friend lobby {}", lobby_id.raw()),
                    );
                }
                Err(()) => {
                    let _ = app.emit("steam_status", "Failed to join invite lobby");
                    if let Ok(mut net) = shared.network_manager.lock() {
                        net.searching = false;
                        net.status = "Invite join failed".into();
                    }
                }
            }
        });
    }

    /// Poll lobby membership; when 2 players present, auto-start.
    /// Solo players re-scan and merge into another waiting lobby.
    pub fn poll_matchmaking(&self, shared: &SharedGameState, app: &AppHandle) {
        let (lobby_raw, is_host, searching, already, peer_ack, start_sent_ms) = {
            let Ok(net) = shared.network_manager.lock() else {
                return;
            };
            (
                net.lobby_id,
                net.is_host,
                net.searching || net.match_started,
                net.match_started,
                net.peer_start_ack,
                net.game_start_sent_ms,
            )
        };

        // After match start: disconnect + GameStart retransmit until ack
        if already {
            if let Some(lobby_raw) = lobby_raw {
                let members = self.mm().lobby_members(LobbyId::from_raw(lobby_raw));
                if members.len() < 2 {
                    let _ = app.emit("steam_status", "Opponent left the match");
                    if let Some(r) = {
                        shared
                            .network_manager
                            .lock()
                            .ok()
                            .and_then(|n| n.remote_steam_id)
                    } {
                        self.send_event(
                            SteamId::from_raw(r),
                            &NetworkEvent::PlayerDisconnected {
                                player_id: if is_host { 0 } else { 1 },
                            },
                        );
                    }
                    if let Ok(mut net) = shared.network_manager.lock() {
                        net.match_started = false;
                        net.connected = false;
                        net.status = "Opponent disconnected".into();
                    }
                    let _ = app.emit(
                        "opponent_left",
                        serde_json::json!({ "reason": "lobby_empty" }),
                    );
                    return;
                }
            }
            // Host: retransmit GameStart until client acks (P2 often misses first packets).
            // Keep going past countdown — otherwise P2 never enters the match.
            if is_host && !peer_ack {
                let now = now_ms();
                let first = if start_sent_ms == 0 {
                    now
                } else {
                    start_sent_ms
                };
                let in_window = now.saturating_sub(first) < GAME_START_RETRY_WINDOW_MS;
                thread_local! {
                    static LAST_GS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
                }
                let due = LAST_GS.with(|c| {
                    let last = c.get();
                    let ok = last == 0 || now.saturating_sub(last) >= GAME_START_RETRY_MS;
                    if ok {
                        c.set(now);
                    }
                    ok
                });
                if in_window && due {
                    self.host_send_game_start(shared, app, false);
                }
            }
            return;
        }

        if !searching {
            return;
        }
        let Some(lobby_raw) = lobby_raw else {
            return;
        };
        let lobby = LobbyId::from_raw(lobby_raw);
        let members = self.mm().lobby_members(lobby);

        // Still alone: wait for player + periodically merge into another open lobby.
        if members.len() < 2 {
            if let Ok(mut net) = shared.network_manager.lock() {
                net.two_player_since_ms = 0;
                net.peer_hello = false;
            }
            self.maybe_merge_solo_queue(shared, lobby_raw, app);
            if let Ok(mut net) = shared.network_manager.lock() {
                if net.searching && !net.match_started && net.lobby_id == Some(lobby_raw) {
                    net.status = format!(
                        "Waiting for player… (1/2) · lobby {} · Best of 5",
                        lobby_raw
                    );
                }
            }
            let _ = app.emit(
                "lobby_roster",
                serde_json::json!({ "members": 1, "ready": false, "max_rounds": 5 }),
            );
            return;
        }

        let me = self.steam_id();
        let remote = members.iter().find(|m| m.raw() != me).map(|m| m.raw());

        // Only HOST starts the match. Client waits for GameStart.
        if !is_host {
            if let Ok(mut net) = shared.network_manager.lock() {
                if let Some(r) = remote {
                    net.remote_steam_id = Some(r);
                }
                net.status = "Opponent found — waiting for host to start… (2/2)".into();
            }
            let _ = app.emit(
                "lobby_roster",
                serde_json::json!({ "members": 2, "ready": false, "max_rounds": 5 }),
            );
            // Keep sending Hello so host has loadout + session proof
            if let Some(r) = remote {
                let (primary, skin, hat) = shared
                    .network_manager
                    .lock()
                    .map(|n| {
                        (
                            n.local_primary.clone(),
                            n.local_skin.clone(),
                            n.local_hat.clone(),
                        )
                    })
                    .unwrap_or(("AR".into(), "default".into(), "none".into()));
                self.send_event(
                    SteamId::from_raw(r),
                    &NetworkEvent::Hello {
                        player_id: 1,
                        primary,
                        skin,
                        hat,
                    },
                );
            }
            return;
        }

        // Host readiness: wait for Hello (or HELLO_WAIT_MS) so P2 is ready
        let (peer_hello, two_since, loadout) = {
            let Ok(mut net) = shared.network_manager.lock() else {
                return;
            };
            if net.match_started {
                return;
            }
            if let Some(r) = remote {
                net.remote_steam_id = Some(r);
            }
            if net.two_player_since_ms == 0 {
                net.two_player_since_ms = now_ms();
            }
            (
                net.peer_hello,
                net.two_player_since_ms,
                (
                    net.local_primary.clone(),
                    net.local_skin.clone(),
                    net.local_hat.clone(),
                ),
            )
        };

        // Host → client Hello warms the Steam session both ways (critical for P2).
        if let Some(r) = remote {
            self.send_event(
                SteamId::from_raw(r),
                &NetworkEvent::Hello {
                    player_id: 0,
                    primary: loadout.0,
                    skin: loadout.1,
                    hat: loadout.2,
                },
            );
        }

        let waited = now_ms().saturating_sub(two_since);
        let ready = (peer_hello && waited >= MIN_READY_MS) || waited >= HELLO_WAIT_MS;
        if !ready {
            let status = if peer_hello {
                format!("Opponent ready — starting… ({waited}ms)")
            } else {
                format!(
                    "Waiting for player ready… (2/2) · {}s",
                    ((HELLO_WAIT_MS.saturating_sub(waited) + 999) / 1000).max(1)
                )
            };
            if let Ok(mut net) = shared.network_manager.lock() {
                net.status = status.clone();
            }
            let _ = app.emit("steam_status", status);
            let _ = app.emit(
                "lobby_roster",
                serde_json::json!({
                    "members": 2,
                    "ready": peer_hello,
                    "max_rounds": 5,
                }),
            );
            return;
        }

        {
            let Ok(mut net) = shared.network_manager.lock() else {
                return;
            };
            if net.match_started {
                return;
            }
            net.match_started = true;
            net.searching = false;
            net.connected = true;
            if let Some(r) = remote {
                net.remote_steam_id = Some(r);
            }
            net.local_player_id = 0;
            net.is_host = true;
            net.status = "Match found! Starting Best of 5…".into();
            net.peer_start_ack = false;
            net.game_start_sent_ms = 0;
        }

        let _ = self.mm().set_lobby_joinable(lobby, false);
        self.mm()
            .set_lobby_data(lobby, LOBBY_KEY_STATUS, LOBBY_VAL_PLAYING);

        {
            let Ok(mut game) = shared.game_state.lock() else {
                return;
            };
            // Fresh match — Best of 5 (first to 3)
            *game = crate::game::state::GameState::new();
            game.max_rounds = 5;
            game.current_round = 1;
            game.score = [0, 0];
            game.add_player(0);
            game.add_player(1);
            if let Ok(net) = shared.network_manager.lock() {
                let hp = crate::game::weapons::WeaponType::from_str_loose(&net.local_primary);
                let pp = crate::game::weapons::WeaponType::from_str_loose(&net.peer_primary);
                game.set_player_loadout(0, hp, &net.local_skin, &net.local_hat);
                game.set_player_loadout(1, pp, &net.peer_skin, &net.peer_hat);
            }
            // Countdown only after both sides are in lobby (and preferably Hello'd)
            game.start_countdown();
        }

        self.host_send_game_start(shared, app, true);
        let _ = app.emit("steam_status", "Match found — you are Player 1 (host) · Best of 5");
        let _ = app.emit(
            "lobby_roster",
            serde_json::json!({ "members": 2, "ready": true, "max_rounds": 5 }),
        );
    }

    /// Build GameStart + seed snapshot and send to peer (and emit match_found once).
    fn host_send_game_start(&self, shared: &SharedGameState, app: &AppHandle, first: bool) {
        let remote = shared
            .network_manager
            .lock()
            .ok()
            .and_then(|n| n.remote_steam_id);
        let Some(r) = remote else {
            return;
        };

        let (countdown, round, score, state_val) = {
            let Ok(game) = shared.game_state.lock() else {
                return;
            };
            let snap = crate::commands::GameStateSnapshot::from_state(&game);
            let state_val = serde_json::to_value(&snap).ok();
            (
                game.countdown_timer,
                game.current_round,
                game.score,
                state_val,
            )
        };

        self.send_event(
            SteamId::from_raw(r),
            &NetworkEvent::GameStart {
                countdown_timer: countdown,
                current_round: round,
                score,
                state: state_val.clone(),
            },
        );

        // Also push a reliable state snapshot on STATE channel
        if let Some(val) = &state_val {
            if let Ok(bytes) = serde_json::to_vec(val) {
                if let Ok(mut out) = shared.outbound.lock() {
                    out.retain(|(ch, _, _)| *ch != CHANNEL_STATE);
                    out.push((CHANNEL_STATE, bytes, true));
                }
            }
        }

        if let Ok(mut net) = shared.network_manager.lock() {
            // Keep first-send timestamp for retry window (do not refresh on retransmit)
            if net.game_start_sent_ms == 0 {
                net.game_start_sent_ms = now_ms();
            }
        }

        if first {
            let _ = app.emit(
                "match_found",
                serde_json::json!({
                    "player_id": 0,
                    "is_host": true,
                    "countdown_timer": countdown,
                    "round_state": "countdown",
                    "max_rounds": 5,
                }),
            );
            // Host local UI: seed countdown immediately
            if let Some(val) = state_val {
                let _ = app.emit("game_state", val);
            }
        }
    }

    /// Client missed GameStart but got a host snapshot — enter match as P2.
    fn client_bootstrap_from_state(
        &self,
        shared: &SharedGameState,
        app: &AppHandle,
        from: u64,
        value: &serde_json::Value,
    ) {
        let already = shared
            .network_manager
            .lock()
            .map(|n| n.match_started)
            .unwrap_or(true);
        if already {
            return;
        }

        let countdown = value
            .get("countdown_timer")
            .and_then(|v| v.as_f64())
            .unwrap_or(3.0);
        let round_state = value
            .get("round_state")
            .and_then(|v| v.as_str())
            .unwrap_or("countdown");

        // Only bootstrap into an active match (not waiting/idle noise)
        if !matches!(
            round_state,
            "countdown" | "playing" | "round_end" | "match_end"
        ) {
            return;
        }

        if let Ok(mut net) = shared.network_manager.lock() {
            net.match_started = true;
            net.searching = false;
            net.local_player_id = 1;
            net.is_host = false;
            net.remote_steam_id = Some(from);
            net.connected = true;
            net.peer_start_ack = true;
            net.status = "Joined match (state sync) — you are Player 2".into();
        }

        let _ = app.emit(
            "match_found",
            serde_json::json!({
                "player_id": 1,
                "is_host": false,
                "countdown_timer": countdown,
                "round_state": round_state,
                "max_rounds": 5,
            }),
        );
        let _ = app.emit("steam_status", "Match starting — you are Player 2");
        self.send_event(SteamId::from_raw(from), &NetworkEvent::GameStartAck);
    }

    /// Solo queue re-scan: re-tag lobby + merge into another waiting lobby.
    /// Prefer lower owner; after STUCK_MERGE_MS join ANY other solo lobby (heal splits).
    /// After SOLO_REQUEUE_MS with no peers: leave and re-queue (nuclear).
    fn maybe_merge_solo_queue(&self, shared: &SharedGameState, our_lobby: u64, app: &AppHandle) {
        thread_local! {
            static LAST: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) };
            static SOLO_SINCE: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) };
        }
        let now = Instant::now();
        let should = LAST.with(|c| {
            let go = match c.get() {
                None => true,
                Some(t) => now.duration_since(t) >= Duration::from_millis(RESCAN_MS),
            };
            if go {
                c.set(Some(now));
            }
            go
        });
        if !should {
            return;
        }

        let solo_ms = SOLO_SINCE.with(|c| match c.get() {
            None => {
                c.set(Some(now));
                0
            }
            Some(t) => now.duration_since(t).as_millis() as u64,
        });

        // Keep lobby discoverable (Steam filter index is eventual).
        self.tag_waiting_lobby(LobbyId::from_raw(our_lobby));

        let Ok(lobbies) = self.request_open_lobbies() else {
            return;
        };
        let me = self.steam_id();
        let others = self.collect_join_candidates(&lobbies, Some(our_lobby), me);

        if others.is_empty() {
            // Nuclear: still nobody visible — drop lobby and re-enter search
            if solo_ms >= SOLO_REQUEUE_MS {
                eprintln!("solo requeue after {solo_ms}ms lobby={our_lobby}");
                self.mm().leave_lobby(LobbyId::from_raw(our_lobby));
                if let Ok(mut net) = shared.network_manager.lock() {
                    net.lobby_id = None;
                    net.is_host = false;
                    net.remote_steam_id = None;
                    net.searching = true;
                    net.reset_match_flags();
                    net.status = "Still alone — re-searching…".into();
                }
                SOLO_SINCE.with(|c| c.set(None));
                let _ = app.emit("steam_status", "Still alone — re-searching for player…");
            } else if solo_ms > 0 {
                let _ = app.emit(
                    "steam_status",
                    format!(
                        "Waiting for player… (1/2) · scanning… {}s",
                        solo_ms / 1000
                    ),
                );
            }
            return;
        }

        let Some((target, owner_id)) = others.first().copied() else {
            return;
        };

        // Prefer joining lower-owner (canonical). After stuck timer, join ANY peer.
        let stuck = solo_ms >= STUCK_MERGE_MS;
        if owner_id > me && !stuck {
            // We are lower steam id — stay; they should join us (unless stuck).
            let _ = app.emit(
                "steam_status",
                format!(
                    "Waiting for player… peer lobby seen — holding host ({}s)",
                    solo_ms / 1000
                ),
            );
            return;
        }
        if owner_id == me {
            return;
        }

        let reason = if owner_id < me {
            "canonical host"
        } else {
            "stuck-merge"
        };
        let _ = app.emit(
            "steam_status",
            format!(
                "Merging → lobby {} ({reason}, owner {owner_id})…",
                target.raw()
            ),
        );

        self.mm().leave_lobby(LobbyId::from_raw(our_lobby));
        match self.join_lobby_raw(target) {
            Ok(lobby_id) => {
                SOLO_SINCE.with(|c| c.set(None));
                let owner = self.mm().lobby_owner(lobby_id);
                if let Ok(mut net) = shared.network_manager.lock() {
                    net.is_host = false;
                    net.local_player_id = 1;
                    net.lobby_id = Some(lobby_id.raw());
                    net.remote_steam_id = Some(owner.raw());
                    net.connected = true;
                    net.searching = true;
                    net.reset_match_flags();
                    net.status = format!("Joined lobby {} — waiting…", lobby_id.raw());
                }
                if let Ok(mut game) = shared.game_state.lock() {
                    *game = crate::game::state::GameState::new();
                    game.add_player(0);
                    game.add_player(1);
                }
                let (primary, skin, hat) = shared
                    .network_manager
                    .lock()
                    .map(|n| {
                        (
                            n.local_primary.clone(),
                            n.local_skin.clone(),
                            n.local_hat.clone(),
                        )
                    })
                    .unwrap_or(("AR".into(), "default".into(), "none".into()));
                self.send_event(
                    owner,
                    &NetworkEvent::Hello {
                        player_id: 1,
                        primary,
                        skin,
                        hat,
                    },
                );
            }
            Err(_) => {
                eprintln!("merge join failed lobby={}", target.raw());
                if let Ok(mut net) = shared.network_manager.lock() {
                    net.lobby_id = None;
                    net.is_host = false;
                    net.searching = true;
                    net.status = "Merge failed — re-searching…".into();
                }
                SOLO_SINCE.with(|c| c.set(None));
            }
        }
    }

    fn send_event(&self, target: SteamId, payload: &impl Serialize) {
        if let Ok(bytes) = serde_json::to_vec(payload) {
            self.send_raw(target, CHANNEL_EVENTS as u32, &bytes, true);
        }
    }

    pub fn send_raw(&self, target: SteamId, channel: u32, bytes: &[u8], reliable: bool) {
        let identity = NetworkingIdentity::new_steam_id(target);
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

    pub fn pump_messages(&self, shared: &SharedGameState) {
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
                if let Ok(mut inbound) = shared.inbound.lock() {
                    inbound.push((from, ch as i32, data));
                }
            }
        }
    }

    pub fn process_inbound(&self, shared: &SharedGameState, app: &AppHandle) {
        let packets: Vec<(u64, i32, Vec<u8>)> = {
            if let Ok(mut inbound) = shared.inbound.lock() {
                inbound.drain(..).collect()
            } else {
                Vec::new()
            }
        };

        for (from, channel, data) in packets {
            match channel {
                c if c == CHANNEL_INPUT => {
                    if let Ok(input) = serde_json::from_slice::<ClientInput>(&data) {
                        let is_host = shared
                            .network_manager
                            .lock()
                            .map(|n| n.is_host)
                            .unwrap_or(false);
                        if is_host {
                            // Remote client is always player 1 in 1v1 host-authoritative model
                            if let Ok(mut pending) = shared.pending_inputs.lock() {
                                pending.push((1, input));
                            }
                            if let Ok(mut net) = shared.network_manager.lock() {
                                if net.remote_steam_id.is_none() {
                                    net.remote_steam_id = Some(from);
                                }
                            }
                        }
                    }
                }
                c if c == CHANNEL_STATE => {
                    // Client only: forward host snapshot to UI (no local sim merge)
                    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&data) {
                        // P2 often gets STATE before GameStart — bootstrap into match
                        let should_bootstrap = shared
                            .network_manager
                            .lock()
                            .map(|n| {
                                !n.is_host
                                    && !n.match_started
                                    && (n.searching || n.lobby_id.is_some())
                            })
                            .unwrap_or(false);
                        if should_bootstrap {
                            self.client_bootstrap_from_state(shared, app, from, &value);
                        }
                        let _ = app.emit("game_state", value);
                    }
                }
                c if c == CHANNEL_EVENTS => {
                    if let Ok(ev) = serde_json::from_slice::<NetworkEvent>(&data) {
                        match ev {
                            NetworkEvent::Hello {
                                player_id,
                                primary,
                                skin,
                                hat,
                            } => {
                                let i_am_host = shared
                                    .network_manager
                                    .lock()
                                    .map(|n| n.is_host)
                                    .unwrap_or(false);
                                if let Ok(mut net) = shared.network_manager.lock() {
                                    net.remote_steam_id = Some(from);
                                    net.connected = true;
                                    // Host stores client loadout; client stores host loadout
                                    if i_am_host && player_id == 1 {
                                        net.peer_primary = primary.clone();
                                        net.peer_skin = skin.clone();
                                        net.peer_hat = if hat.is_empty() {
                                            "none".into()
                                        } else {
                                            hat.clone()
                                        };
                                        net.peer_hello = true;
                                        net.status = "Opponent ready — preparing Best of 5…".into();
                                    } else if !i_am_host && player_id == 0 {
                                        net.peer_primary = primary.clone();
                                        net.peer_skin = skin.clone();
                                        net.peer_hat = if hat.is_empty() {
                                            "none".into()
                                        } else {
                                            hat.clone()
                                        };
                                        net.status =
                                            "Host connected — waiting for match start…".into();
                                    } else {
                                        // Fallback: still record peer loadout
                                        net.peer_primary = primary.clone();
                                        net.peer_skin = skin.clone();
                                        net.peer_hat = if hat.is_empty() {
                                            "none".into()
                                        } else {
                                            hat.clone()
                                        };
                                        if i_am_host {
                                            net.peer_hello = true;
                                        }
                                    }
                                }
                                if let Ok(mut game) = shared.game_state.lock() {
                                    if !game.players.iter().any(|p| p.id == player_id) {
                                        game.add_player(player_id);
                                    }
                                    let wt =
                                        crate::game::weapons::WeaponType::from_str_loose(&primary);
                                    let hat_id = if hat.is_empty() { "none" } else { &hat };
                                    game.set_player_loadout(player_id, wt, &skin, hat_id);
                                }
                                if i_am_host {
                                    let _ = app.emit(
                                        "steam_status",
                                        "Opponent ready — waiting to start…",
                                    );
                                    let _ = app.emit(
                                        "lobby_roster",
                                        serde_json::json!({
                                            "members": 2,
                                            "ready": true,
                                            "max_rounds": 5,
                                        }),
                                    );
                                } else {
                                    let _ = app.emit(
                                        "steam_status",
                                        "Host found — waiting for start…",
                                    );
                                }
                            }
                            NetworkEvent::GameStartAck => {
                                if let Ok(mut net) = shared.network_manager.lock() {
                                    net.peer_start_ack = true;
                                }
                            }
                            NetworkEvent::GameStart {
                                countdown_timer,
                                current_round,
                                score,
                                state,
                            } => {
                                // Client: seed UI immediately from GameStart payload
                                let already = shared
                                    .network_manager
                                    .lock()
                                    .map(|n| n.match_started)
                                    .unwrap_or(false);

                                if let Ok(mut game) = shared.game_state.lock() {
                                    if !game.players.iter().any(|p| p.id == 0) {
                                        game.add_player(0);
                                    }
                                    if !game.players.iter().any(|p| p.id == 1) {
                                        game.add_player(1);
                                    }
                                    if let Ok(net) = shared.network_manager.lock() {
                                        let lp = crate::game::weapons::WeaponType::from_str_loose(
                                            &net.local_primary,
                                        );
                                        let pp = crate::game::weapons::WeaponType::from_str_loose(
                                            &net.peer_primary,
                                        );
                                        game.set_player_loadout(
                                            1,
                                            lp,
                                            &net.local_skin,
                                            &net.local_hat,
                                        );
                                        game.set_player_loadout(
                                            0,
                                            pp,
                                            &net.peer_skin,
                                            &net.peer_hat,
                                        );
                                    }
                                    // Seed local view of countdown (display only; host sims)
                                    if matches!(
                                        game.round_state,
                                        crate::game::state::RoundState::WaitingForPlayers
                                    ) {
                                        game.round_state =
                                            crate::game::state::RoundState::Countdown;
                                        game.countdown_timer = countdown_timer;
                                        game.current_round = current_round;
                                        game.score = score;
                                    }
                                }
                                if let Ok(mut net) = shared.network_manager.lock() {
                                    net.match_started = true;
                                    net.searching = false;
                                    net.local_player_id = 1;
                                    net.is_host = false;
                                    net.remote_steam_id = Some(from);
                                    net.connected = true;
                                }

                                // Emit seed state so UI shows countdown immediately
                                if let Some(val) = state {
                                    let _ = app.emit("game_state", val);
                                } else {
                                    let _ = app.emit(
                                        "game_state",
                                        serde_json::json!({
                                            "tick": 0,
                                            "round_state": "countdown",
                                            "current_round": current_round,
                                            "max_rounds": 5,
                                            "score": score,
                                            "players": [],
                                            "projectiles": [],
                                            "grenades": [],
                                            "pickups": [],
                                            "countdown_timer": countdown_timer,
                                            "winner_id": null,
                                            "zone_x": 640.0,
                                            "zone_y": 360.0,
                                            "zone_radius": 380.0,
                                            "zone_target_radius": 380.0,
                                            "match_time": 0.0,
                                        }),
                                    );
                                }

                                if !already {
                                    let _ = app.emit(
                                        "match_found",
                                        serde_json::json!({
                                            "player_id": 1,
                                            "is_host": false,
                                            "countdown_timer": countdown_timer,
                                            "round_state": "countdown",
                                            "max_rounds": 5,
                                        }),
                                    );
                                }
                                let _ = app.emit(
                                    "steam_status",
                                    "Match starting — you are Player 2 · Best of 5",
                                );

                                // Ack so host stops retransmitting (always — not only first)
                                self.send_event(
                                    SteamId::from_raw(from),
                                    &NetworkEvent::GameStartAck,
                                );
                            }
                            NetworkEvent::Combat { event } => {
                                let event_name = match &event {
                                    crate::game::state::SoundEvent::WeaponFired { .. } => {
                                        "weapon_fired"
                                    }
                                    crate::game::state::SoundEvent::PlayerHit { .. } => {
                                        "player_hit"
                                    }
                                    crate::game::state::SoundEvent::PlayerDied { .. } => {
                                        "player_died"
                                    }
                                    crate::game::state::SoundEvent::RoundEnd => "round_end",
                                    crate::game::state::SoundEvent::WeaponPickup { .. } => {
                                        "weapon_pickup"
                                    }
                                    crate::game::state::SoundEvent::Reload { .. } => "reload",
                                    crate::game::state::SoundEvent::Dash { .. } => "dash",
                                };
                                let _ = app.emit(event_name, serde_json::to_value(&event).ok());
                            }
                            NetworkEvent::PlayerDisconnected { .. } => {
                                let _ = app.emit("opponent_left", serde_json::json!({}));
                                let _ = app.emit("steam_status", "Opponent disconnected");
                            }
                            NetworkEvent::Loadout {
                                player_id,
                                primary,
                                skin,
                                hat,
                            } => {
                                if let Ok(mut game) = shared.game_state.lock() {
                                    let wt =
                                        crate::game::weapons::WeaponType::from_str_loose(&primary);
                                    let hat_id = if hat.is_empty() { "none" } else { &hat };
                                    game.set_player_loadout(player_id, wt, &skin, hat_id);
                                }
                            }
                            other => {
                                let _ = app.emit("steam_status", format!("{other:?}"));
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }

    pub fn flush_outbound(&self, shared: &SharedGameState) {
        let remote = shared
            .network_manager
            .lock()
            .ok()
            .and_then(|n| n.remote_steam_id);
        let Some(remote) = remote else {
            return;
        };
        let target = SteamId::from_raw(remote);

        let packets: Vec<(i32, Vec<u8>, bool)> = {
            if let Ok(mut out) = shared.outbound.lock() {
                out.drain(..).collect()
            } else {
                Vec::new()
            }
        };

        for (ch, bytes, reliable) in packets {
            self.send_raw(target, ch as u32, &bytes, reliable);
        }
    }

    /// If searching with no lobby (e.g. after failed merge), try join first, then recreate.
    pub fn ensure_queue_lobby(&self, shared: Arc<SharedGameState>) {
        let need = {
            let Ok(net) = shared.network_manager.lock() else {
                return;
            };
            net.searching && !net.match_started && net.lobby_id.is_none()
        };
        if !need {
            return;
        }
        if self.creating.load(Ordering::SeqCst) {
            return;
        }

        thread_local! {
            static LAST: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) };
        }
        let now = Instant::now();
        let go = LAST.with(|c| {
            let go = match c.get() {
                None => true,
                // Faster recovery after failed merge / orphan queue
                Some(t) => now.duration_since(t) >= Duration::from_millis(1500),
            };
            if go {
                c.set(Some(now));
            }
            go
        });
        if !go {
            return;
        }

        // Prefer joining an existing lobby over spawning another orphan.
        if let Ok(Some(msg)) = self.try_join_best_open_lobby(Arc::clone(&shared), None) {
            Self::set_status(&shared, msg);
            return;
        }

        // Still alone — create (serialized)
        match self.create_waiting_lobby(Arc::clone(&shared)) {
            Ok(msg) => Self::set_status(&shared, msg),
            Err(e) => {
                eprintln!("ensure_queue_lobby create: {e}");
                Self::set_status(&shared, format!("Recreate failed: {e}"));
            }
        }
    }
}

pub fn spawn_steam_thread(app: AppHandle, shared: Arc<SharedGameState>, steam: Arc<SteamRuntime>) {
    // Friend invites → join their lobby automatically
    {
        let steam_cb = Arc::clone(&steam);
        let shared_cb = Arc::clone(&shared);
        let app_cb = app.clone();
        let handle = steam.client.register_callback(move |ev: GameLobbyJoinRequested| {
            eprintln!(
                "invite join requested: lobby={} from={}",
                ev.lobby_steam_id.raw(),
                ev.friend_steam_id.raw()
            );
            steam_cb.accept_lobby_invite(Arc::clone(&shared_cb), &app_cb, ev.lobby_steam_id);
        });
        // Keep callback registered for process lifetime
        std::mem::forget(handle);
    }

    std::thread::spawn(move || {
        let mut tick: u64 = 0;
        loop {
            steam.pump_messages(&shared);
            steam.process_inbound(&shared, &app);
            steam.flush_outbound(&shared);

            let match_live = shared
                .network_manager
                .lock()
                .map(|n| n.match_started && n.remote_steam_id.is_some())
                .unwrap_or(false);

            // Matchmaking poll: more often while queuing so dual-create merges faster
            tick += 1;
            let mm_every = if match_live { 8 } else { 2 };
            if tick % mm_every == 0 {
                steam.poll_matchmaking(&shared, &app);
                if !match_live {
                    steam.ensure_queue_lobby(Arc::clone(&shared));
                    if let Ok(net) = shared.network_manager.lock() {
                        if net.searching {
                            let _ = app.emit("steam_status", net.status.clone());
                        }
                    }
                }
            }

            // In-match: pump hard (1ms). Queue: 12ms for snappier lobby merge.
            std::thread::sleep(Duration::from_millis(if match_live { 1 } else { 12 }));
        }
    });
}
