# Lobby v0.2.2

A personal game launcher for you and your friends: your `.exe` games in one library, a friends list,
lobbies with invites and chat, and multiplayer that **never shares anyone's IP address** with other players.

## Download (Windows 10/11, 64-bit)

| File | What it is |
|---|---|
| `Lobby-Setup-0.2.2.exe` | **Installer (recommended).** Run it. It adds Start-menu and desktop shortcuts. |
| `Lobby-0.2.2-win-x64.zip` | **Portable.** Unzip anywhere and run `Lobby.exe`. |
| `Tap-Race-example-game.zip` | Example Lobby Certified game. Add it in Lobby with **Library**, **+**, **Add .zip package**. |
| `LOBBY-DEV-INSTRUCTIONS.md` | Give this to any AI or developer to build a Lobby Certified game. |

> Windows SmartScreen may warn "unknown publisher" because the app isn't code-signed yet.
> Click **More info**, then **Run anyway**.

## Getting started

**The host (one person in the group):**
1. Install Cloudflare's tunnel tool once: open PowerShell and run `winget install --id Cloudflare.cloudflared`.
2. Open Lobby. On the login screen, click **Start a server on this PC**, then create your account.
3. Go to **Settings** and click **Share over the internet**.
4. Click **Copy** and send friends the `wss://…trycloudflare.com` address. It changes each time you start sharing.

**Friends:**
1. Install Lobby.
2. On the login screen, under **Joining a friend?**, paste the host's `wss://` address and click **Connect**.
3. Create an account, add the host as a friend (in **Hub**), and you're in.

**LAN party:** the host also turns on **Allow LAN connections**. People on the same network use the
`ws://192.168.x.x:47420` address shown in Settings.

## What's new in 0.2.2
- Fixed: after clicking **Share over the internet**, the address showed as `[object HTMLSpanElement]…` instead of the copyable `wss://` link.
- Friends who paste a `127.0.0.1` address now get told to ask the host for the `wss://` one instead.

## What's new in 0.2.1
- Fixed: the host could get stuck on "Not connected to the Lobby server". The login screen now has **Start a server on this PC** and **Joining a friend?** options.

## What's in this version
- Library for any `.exe` (add or scan folders), play time, launch options, favorites, and a mods folder per game
- Hub: friends, requests, DMs, lobbies, invites, ready-up, lobby chat
- Relay network: share a game server port with your lobby (TCP/UDP). Friends connect through `127.0.0.1`,
  never to your IP.
- **Lobby Certified** games: sandboxed HTML5 games with built-in multiplayer. **Blast Arena** is included,
  and you can add more with **+**.
- Settings: profile photo, server address, host a server from the app (LAN and Cloudflare tunnel)

## Privacy
- Players only ever connect to the Lobby server, never to each other, so no player sees another's IP.
- Lobby Certified games run with **no internet access** (no web requests, no WebRTC), so a game can't leak IPs either.
- Passwords are hashed (scrypt), and your saved login is encrypted with Windows DPAPI.
- Profile photos are re-encoded to a small PNG, which strips location/EXIF data.
- Whoever hosts the server can see the IPs of people connecting to it, just as Steam or Discord can.
  With a Cloudflare tunnel, the host's own IP stays hidden too.

## Uploading this to GitHub
GitHub won't accept files over 100 MB inside a repository. Upload `Lobby-Setup-0.2.2.exe` and the `.zip` as
**Release assets** instead: Repository, then **Releases**, then **Draft a new release**, then drag the files in.
