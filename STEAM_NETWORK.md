# SteamNetworkManager — DUSTLINE

Rust-Implementierung der Steamworks-Lobby + P2P-Schicht  
(Analog zu C++ `ISteamMatchmaking` + `ISteamNetworkingMessages`).

## Module

| Datei | Rolle |
|-------|--------|
| `src-tauri/src/steam_manager.rs` | **SteamNetworkManager** — Init, Lobby, Browser, Events, Handshake |
| `src-tauri/src/steam_net.rs` | Bridge → Game (GameStart, Inputs, State Snapshots) |
| `src-tauri/src/network.rs` | Shared Types / Session |
| `src-tauri/steam_appid.txt` | App-ID **480** (Spacewar) für Tests |

## Zustandsmaschine

```
Idle
  → CreatingLobby / JoiningLobby
  → HostingLobby | InLobby
  → Connecting   (P2P Handshake)
  → InGame       (Handshake OK → Match startet)
```

## Tauri Commands

| Command | Steam-Äquivalent |
|---------|------------------|
| *(auto)* `SteamRuntime::try_init` | `SteamAPI_Init` + `RunCallbacks`-Thread |
| `steam_find_match` | Auto: `RequestLobbyList` → `JoinLobby` / `CreateLobby(Public)` |
| `steam_create_lobby` `{ visibility: "public"\|"friends"\|"private" }` | `CreateLobby` |
| `steam_request_lobby_list` | `RequestLobbyList` → Event `lobby_list` |
| `steam_join_lobby` `{ lobbyId }` | `JoinLobby` |
| `steam_invite_friends` | Overlay Invite + Rich Presence `connect` |
| `steam_cancel_matchmaking` | Leave lobby |
| `steam_session` | Snapshot (State, Lobby-ID, RTT, …) |

## Events (Frontend)

Listen auf:

- **`steam_event`** — strukturiert (`InitOk`, `LobbyCreated`, `LobbyList`, `LobbyEntered`, `MemberJoined`/`Left`, `Handshake`, `MatchReady`, …)
- **`lobby_state`** — UI-Snapshot für Lobby-Screen
- **`match_found`** — Spiel startet (Game-Layer)
- **`steam_status`** — kurze Statuszeile

```ts
await listen('steam_event', (e) => {
  const ev = e.payload;
  switch (ev.type) {
    case 'lobby_list': console.log(ev.lobbies); break;
    case 'match_ready': /* optional */ break;
    case 'handshake': console.log(ev.rtt_ms); break;
  }
});
```

## C++ → Rust Mapping

| C++ | Diese Codebase |
|-----|----------------|
| `SteamAPI_Init()` | `SteamNetworkManager::try_init()` |
| `SteamAPI_RunCallbacks()` | eigener Thread, 5 ms |
| `STEAM_CALLBACK(…, LobbyCreated_t)` | `create_lobby` / `create_lobby_blocking` + Channel |
| `CreateLobby(k_ELobbyTypePublic, 2)` | `create_lobby(Public)` · max **2** |
| `SetLobbyData` | `apply_lobby_metadata` (`game=DUSTLINE`, `status`, `map`, `host`, `ver`) |
| `RequestLobbyList` | `request_lobby_list` / `list_lobbies_blocking_pub` |
| `JoinLobby` | `join_lobby` / `join_lobby_blocking` |
| `LobbyChatUpdate_t` | `tick_lobby` Member-Diff |
| `ISteamNetworkingMessages` | `send_raw` / `pump_messages` |
| Rich Presence `connect` | `+connect_lobby <id>` |

## Stolperfallen

1. **Steam muss laufen** und eingeloggt sein — sonst schlägt Init fehl.
2. **Callbacks** feuern nur, wenn `run_callbacks` regelmäßig läuft (bei uns eigener Thread).
3. **App-ID 480 (Spacewar)** teilt Lobby-Listen mit allen Test-Games → immer `game=DUSTLINE` filtern.
4. **Lobby-Metadata** ist *eventual consistent* — direkt nach Create oft leere Listen (1–5 s warten / retry).
5. **Nur eine** `RequestLobbyList` gleichzeitig (Mutex).
6. **`open_slots`-Filter** liefert auf Spacewar oft 0 Treffer — Members clientseitig filtern.
7. **JoinLobby** schlägt fehl bei voll / gelöscht / Race — soft-error + re-list.
8. **1v1 Host leave** → Lobby für den anderen beenden (kein Host-Migration).
9. **NAT**: `init_relay_network_access()` ist Pflicht für Internet-Relay.
10. **Firewall / Antivirus** kann Relay blocken; Steam-Overlay hilft bei Diagnose.
11. **Produktion**: `steam_appid.txt` + Partner-Dashboard echte App-ID — **nie 480 shippen**.
12. Handshake-Timeout (~4 s) startet Match trotzdem (langsamer Relay).

## Manueller Flow (Browser)

```
steam_request_lobby_list  →  steam_event lobby_list
steam_join_lobby { lobbyId }
// oder
steam_create_lobby { visibility: "friends" }
steam_invite_friends
```

## Auto-Queue (aktuelles Find Match)

```
Search (gestaffelt 2.5–7s)
  → Join erste freie DUSTLINE-Lobby (1/2)
  → sonst CreateLobby(Public)
tick_lobby: 2 Mitglieder → P2P Handshake (ping/pong)
Handshake OK → Host startet Countdown / GameStart
```
