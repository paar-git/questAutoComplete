# QuestAutoComplete

Adds a button next to Mute/Deafen, beside FakeDeafen and MOM FBI (also in the Vencord Toolbox menu, if that plugin is on), that finishes the Discord quests you have **already accepted**.

1. Accept quests in Discover → Quests.
2. Click the quest button. It says "Activated for N accepted quests" and lists them, or tells you there are no accepted quests.
3. It turns green and pulses while it works. When every quest is done it turns itself off and tells you.
4. Click it while it runs to stop early. Discord keeps any progress already made.

The button can be hidden in the plugin settings ("Show the quest button next to Mute/Deafen").

### Running quests at the same time

By default quests run one after another, so two 15-minute play quests take 30 minutes. Turn on **"Run quests at the same time"** in the plugin settings to run them together: Discord is shown all the quest games running at once, so the whole batch takes about as long as the longest quest. Video and activity quests run alongside them too. Stream quests still take turns, because Discord only tracks one active stream.

This is a little riskier, because Discord sees several games running at once. It is off by default.

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
