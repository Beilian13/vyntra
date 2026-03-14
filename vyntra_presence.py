#!/usr/bin/env python3
"""
Vyntra Presence Companion v1.0
================================
Automatically detects running games and updates your Vyntra "Now Playing" status.

Supported platforms: Windows, Linux, macOS
Detects: Roblox (Windows), Sober (Linux Roblox client), + 30 common games

Setup:
  1. pip install psutil requests
  2. Set VYNTRA_TOKEN below (copy from Settings → Profile → Now Playing → Get Script)
  3. python vyntra_presence.py
"""

import time
import platform
import sys

# ── CONFIG ────────────────────────────────────────────────────────────────────
VYNTRA_URL   = "https://vyntra-zlfn.onrender.com"   # your Vyntra server URL
VYNTRA_TOKEN = "PASTE_YOUR_TOKEN_HERE"              # from localStorage 'vt' in browser devtools
POLL_INTERVAL = 10                                  # seconds between checks
# ──────────────────────────────────────────────────────────────────────────────

try:
    import psutil
    import requests
except ImportError:
    print("Missing dependencies. Run:\n  pip install psutil requests")
    sys.exit(1)

# Process name → (Display Name, presence type)
GAMES = {
    # ── Roblox ──
    "RobloxPlayerBeta.exe":                     ("Roblox", "roblox"),
    "RobloxPlayer.exe":                         ("Roblox", "roblox"),
    "RobloxCrashHandler.exe":                   ("Roblox", "roblox"),
    # ── Sober (Linux Roblox client) ──
    "sober":                                    ("Roblox (Sober)", "sober"),
    "Sober":                                    ("Roblox (Sober)", "sober"),
    "sober-player":                             ("Roblox (Sober)", "sober"),
    # ── Minecraft ──
    "Minecraft.exe":                            ("Minecraft", "custom"),
    "javaw.exe":                                ("Minecraft", "custom"),   # Windows Java
    "java":                                     ("Minecraft", "custom"),   # Linux Java
    "MultiMC.exe":                              ("Minecraft (MultiMC)", "custom"),
    "PrismLauncher.exe":                        ("Minecraft (Prism)", "custom"),
    "prismlauncher":                            ("Minecraft (Prism)", "custom"),
    # ── Fortnite ──
    "FortniteClient-Win64-Shipping.exe":        ("Fortnite", "custom"),
    # ── Valorant ──
    "VALORANT-Win64-Shipping.exe":              ("Valorant", "custom"),
    # ── League of Legends ──
    "League of Legends.exe":                    ("League of Legends", "custom"),
    "LeagueClient.exe":                         ("League of Legends", "custom"),
    "leagueclient":                             ("League of Legends", "custom"),
    # ── CS2 / CSGO ──
    "cs2.exe":                                  ("Counter-Strike 2", "custom"),
    "csgo.exe":                                 ("CS:GO", "custom"),
    "cs2":                                      ("Counter-Strike 2", "custom"),
    # ── Apex Legends ──
    "r5apex.exe":                               ("Apex Legends", "custom"),
    # ── GTA V ──
    "GTA5.exe":                                 ("GTA V", "custom"),
    "gta5":                                     ("GTA V", "custom"),
    # ── Genshin Impact ──
    "GenshinImpact.exe":                        ("Genshin Impact", "custom"),
    # ── Overwatch 2 ──
    "Overwatch.exe":                            ("Overwatch 2", "custom"),
    # ── Steam ──
    "steam.exe":                                ("Steam", "custom"),
    "steam":                                    ("Steam", "custom"),
    # ── Spotify ──
    "Spotify.exe":                              ("Spotify", "custom"),
    "spotify":                                  ("Spotify", "custom"),
}

def get_running_game():
    """Returns (display_name, type) of first detected game, or (None, None)."""
    try:
        running = {p.name() for p in psutil.process_iter(["name"])}
        for proc_name, (display, gtype) in GAMES.items():
            if proc_name in running:
                return display, gtype
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass
    return None, None

def set_presence(game, detail, gtype):
    try:
        r = requests.post(
            f"{VYNTRA_URL}/presence",
            json={"game": game, "detail": detail, "type": gtype},
            headers={"Authorization": f"Bearer {VYNTRA_TOKEN}"},
            timeout=8,
        )
        if r.status_code == 401:
            print("❌ Invalid token — update VYNTRA_TOKEN in the script")
            sys.exit(1)
    except requests.exceptions.ConnectionError:
        print("⚠  Could not reach Vyntra (server may be sleeping, retrying…)")
    except Exception as e:
        print(f"⚠  Error: {e}")

def clear_presence():
    try:
        requests.post(
            f"{VYNTRA_URL}/presence",
            json={"game": None},
            headers={"Authorization": f"Bearer {VYNTRA_TOKEN}"},
            timeout=8,
        )
    except Exception:
        pass

def main():
    if VYNTRA_TOKEN == "PASTE_YOUR_TOKEN_HERE":
        print("⚠  You need to set your token!")
        print("   1. Open Vyntra in your browser")
        print("   2. Open DevTools (F12) → Console")
        print("   3. Type: localStorage.getItem('vt')")
        print("   4. Paste that value as VYNTRA_TOKEN in this script\n")
        sys.exit(1)

    print(f"🎮 Vyntra Presence Companion")
    print(f"   Platform : {platform.system()} {platform.release()}")
    print(f"   Server   : {VYNTRA_URL}")
    print(f"   Polling  : every {POLL_INTERVAL}s")
    print(f"   Games    : {len(GAMES)} tracked\n")

    last_game = None

    while True:
        game, gtype = get_running_game()

        if game != last_game:
            if game:
                detail = "In a game"
                if gtype == "sober":
                    detail = "Playing via Sober (Linux)"
                print(f"▶  Detected: {game} [{gtype}]")
                set_presence(game, detail, gtype)
            else:
                print("■  No game — clearing presence")
                clear_presence()
            last_game = game

        time.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nClearing presence and exiting…")
        clear_presence()
        sys.exit(0)
