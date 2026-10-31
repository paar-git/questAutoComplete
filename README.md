# QuestAutoComplete

Adds a button to the chat bar (and to the Vencord Toolbox menu, if that plugin is on) that finishes the Discord quests you have **already accepted**.

1. Accept quests in Discover → Quests.
2. Click the quest button in the chat bar.
3. Click it again while it runs to stop. Discord keeps any progress already made.

| Quest type | What happens |
|---|---|
| Watch video (desktop / mobile) | Sends video progress, never faster than real time since you accepted the quest |
| Play on desktop | Discord is told the game is running until its own heartbeats reach the target (desktop app only) |
| Stream on desktop | You must screen-share in a voice channel with at least one viewer (desktop app only) |
| Play activity | Sends activity heartbeats every 25s |

## Safety

- All requests go through Discord's own REST client to Discord's own API. The plugin never reads your token and never contacts any other server.
- It retries on rate limits, stops after 8 errors in a row, and handles one quest at a time.
- Anything it overrides (running games, stream metadata) is restored when a quest finishes, when you stop it, or when the plugin is disabled.
- Automating quests is against Discord's Terms of Service. Discord can void rewards or act on accounts that do it, and no plugin can rule that out.
