/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findComponentByCodeLazy, findLazy } from "@webpack";
import {
    Alerts,
    ApplicationStreamingStore,
    ChannelStore,
    FluxDispatcher,
    GuildChannelStore,
    Menu,
    RestAPI,
    RunningGameStore,
    showToast,
    useEffect,
    useState
} from "@webpack/common";

import managedStyle from "./style.css?managed";

const logger = new Logger("QuestAutoComplete");

const SUPPORTED_TASKS = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"] as const;
type TaskName = typeof SUPPORTED_TASKS[number];

const BETWEEN_QUESTS_DELAY = 3000;
const ERROR_RETRY_DELAY = 3000;
const ACTIVITY_HEARTBEAT_INTERVAL = 25_000;
const VIDEO_STEP_SECONDS = 5;
const VIDEO_STEP_INTERVAL = 2000;
/** Give up on a quest after this many failed requests in a row instead of hammering the API forever. */
const MAX_CONSECUTIVE_ERRORS = 8;
const STALL_WARNING_MS = 3 * 60_000;

const settings = definePluginSettings({
    showButton: {
        type: OptionType.BOOLEAN,
        description: "Show the quest button next to Mute/Deafen",
        default: true,
        restartNeeded: true
    },
    showProgressToasts: {
        type: OptionType.BOOLEAN,
        description: "Show a toast every time a quest's progress goes up (start / finish toasts are always shown)",
        default: false
    }
});

/** Discord's quest store. Matched by shape so it survives store renames. */
const QuestsStore: { quests: Map<string, any>; } = findLazy(m =>
    typeof m?.getQuest === "function" && typeof m.quests?.values === "function"
);

// ---------------------------------------------------------------- state

interface RunState {
    running: boolean;
    current: string | null;
    detail: string;
    done: number;
    total: number;
}

let state: RunState = { running: false, current: null, detail: "", done: 0, total: 0 };
let abortController: AbortController | null = null;
/** Undo functions for every Discord method we have swapped out. Always drained on stop. */
const cleanups = new Set<() => void>();
const listeners = new Set<() => void>();

function setState(patch: Partial<RunState>) {
    state = { ...state, ...patch };
    listeners.forEach(l => l());
}

function useRunState() {
    const [s, set] = useState(state);
    useEffect(() => {
        const l = () => set(state);
        listeners.add(l);
        return () => void listeners.delete(l);
    }, []);
    return s;
}

function toast(text: string, variant: "default" | "success" | "critical" = "default") {
    showToast({ text, variant, position: "bottom" });
}

class Aborted extends Error { }

/** Discord REST errors are plain objects with status/body instead of Error instances. */
function errorText(err: any): string {
    return err?.body?.message ?? err?.message ?? (err?.status ? `HTTP ${err.status}` : "failed");
}

function sleep(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new Aborted());
        const onAbort = () => { clearTimeout(t); reject(new Aborted()); };
        const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

// ---------------------------------------------------------------- requests

/**
 * Every request goes through Discord's own REST client to discord.com relative URLs.
 * Nothing is sent anywhere else and the token is never read by this plugin.
 */
async function request(method: "get" | "post", options: { url: string; body?: any; }, signal: AbortSignal, retries = 3): Promise<any> {
    for (let i = 0; ; i++) {
        if (signal.aborted) throw new Aborted();
        try {
            const res = await RestAPI[method](options);
            const remaining = res?.headers?.["x-ratelimit-remaining"];
            const resetAfter = res?.headers?.["x-ratelimit-reset-after"];
            if (remaining === "0" && resetAfter) await sleep(parseFloat(resetAfter) * 1000, signal);
            return res;
        } catch (err: any) {
            if (err instanceof Aborted) throw err;
            if (err?.status === 429 && i < retries - 1) {
                const retryAfter = Number(err?.body?.retry_after) || 5;
                logger.warn(`Rate limited, waiting ${retryAfter}s`);
                await sleep(retryAfter * 1000, signal);
                continue;
            }
            throw err;
        }
    }
}

// ---------------------------------------------------------------- quest helpers

function getTaskConfig(quest: any) {
    return quest.config.taskConfig ?? quest.config.taskConfigV2;
}

function getTaskName(quest: any): TaskName | undefined {
    const tasks = getTaskConfig(quest)?.tasks ?? {};
    return SUPPORTED_TASKS.find(t => tasks[t] != null);
}

// Discord moved the game from config.application into each task's applications list.
function getQuestAppId(quest: any, task: TaskName): string {
    const id = getTaskConfig(quest)?.tasks?.[task]?.applications?.[0]?.id ?? quest.config.application?.id;
    if (!id) throw new Error("This quest has no game attached");
    return id;
}

function questName(quest: any): string {
    return quest.config?.messages?.questName ?? quest.id;
}

/** Quests you have accepted, not finished, not expired, and of a type we know how to do. */
function getPendingQuests(): any[] {
    const quests = QuestsStore?.quests;
    if (!quests) return [];
    return [...quests.values()].filter(q =>
        q.userStatus?.enrolledAt
        && !q.userStatus?.completedAt
        && new Date(q.config.expiresAt).getTime() > Date.now()
        && getTaskName(q) != null
    );
}

const isDesktopApp = () => typeof (window as any).DiscordNative !== "undefined";

function progressFromHeartbeat(quest: any, task: TaskName, data: any): number {
    return quest.config.configVersion === 1
        ? data.userStatus?.streamProgressSeconds ?? 0
        : Math.floor(data.userStatus?.progress?.[task]?.value ?? 0);
}

function reportProgress(quest: any, progress: number, needed: number) {
    const pct = Math.min(100, Math.floor(progress / needed * 100));
    setState({ detail: `${pct}%` });
    if (settings.store.showProgressToasts) toast(`${questName(quest)}: ${pct}%`);
}

// ---------------------------------------------------------------- task runners

async function doVideo(quest: any, needed: number, done: number, signal: AbortSignal) {
    const enrolledAt = new Date(quest.userStatus.enrolledAt).getTime();
    let current = done;
    let completed = false;
    let errors = 0;

    while (current < needed) {
        // Server rejects progress claimed faster than real time since enrolment, so stay under that cap.
        const maxAllowed = Math.floor((Date.now() - enrolledAt) / 1000) + 10;
        const next = Math.min(needed, current + VIDEO_STEP_SECONDS);

        if (maxAllowed - current >= VIDEO_STEP_SECONDS) {
            try {
                const res = await request("post", {
                    url: `/quests/${quest.id}/video-progress`,
                    body: { timestamp: next + Math.random() }
                }, signal);
                completed = res?.body?.completed_at != null;
                current = next;
                errors = 0;
                reportProgress(quest, current, needed);
            } catch (err) {
                if (err instanceof Aborted) throw err;
                if (++errors >= MAX_CONSECUTIVE_ERRORS) throw err;
                logger.error(`${questName(quest)}: video progress failed`, err);
                await sleep(ERROR_RETRY_DELAY, signal);
                continue;
            }
        }
        await sleep(VIDEO_STEP_INTERVAL, signal);
    }

    if (!completed) {
        await request("post", { url: `/quests/${quest.id}/video-progress`, body: { timestamp: needed } }, signal);
    }
}

/** Resolves once Discord's own heartbeats report the task as complete. */
function waitForHeartbeats(quest: any, task: TaskName, needed: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const warnIfStalled = () => toast(`${questName(quest)}: no progress from Discord for ${STALL_WARNING_MS / 60000} min. ${task === "STREAM_ON_DESKTOP" ? "Make sure you are screen sharing with someone watching." : "Make sure the Discord desktop app is open and not idle."}`, "critical");
        let stallTimer = setTimeout(warnIfStalled, STALL_WARNING_MS);
        const handler = (data: any) => {
            if (data.questId && data.questId !== quest.id) return;
            clearTimeout(stallTimer);
            stallTimer = setTimeout(warnIfStalled, STALL_WARNING_MS);
            const progress = progressFromHeartbeat(quest, task, data);
            reportProgress(quest, progress, needed);
            if (progress >= needed) { finish(); resolve(); }
        };
        const onAbort = () => { finish(); reject(new Aborted()); };
        const finish = () => {
            clearTimeout(stallTimer);
            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", handler);
            signal.removeEventListener("abort", onAbort);
        };
        if (signal.aborted) return onAbort();
        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", handler);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

async function doPlay(quest: any, needed: number, done: number, signal: AbortSignal) {
    const appId = getQuestAppId(quest, "PLAY_ON_DESKTOP");
    const res = await request("get", { url: `/applications/public?application_ids=${appId}` }, signal);
    const app = res?.body?.[0];
    if (!app) throw new Error("Could not look up the quest's game");

    const exeName = app.executables?.find((x: any) => x.os === "win32")?.name?.replace(">", "")
        ?? app.name.replace(/[/\\:*?"<>|]/g, "");
    const pid = Math.floor(Math.random() * 30000) + 1000;
    const fakeGame = {
        cmdLine: `C:\\Program Files\\${app.name}\\${exeName}`,
        exeName,
        exePath: `c:/program files/${app.name.toLowerCase()}/${exeName}`,
        hidden: false,
        isLauncher: false,
        id: appId,
        name: app.name,
        pid,
        pidPath: [pid],
        processName: app.name,
        start: Date.now()
    };

    const store = RunningGameStore as any;
    const realGames = store.getRunningGames();
    const realGetRunningGames = store.getRunningGames;
    const realGetGameForPID = store.getGameForPID;

    store.getRunningGames = () => [fakeGame];
    store.getGameForPID = (p: number) => p === pid ? fakeGame : null;
    FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: realGames, added: [fakeGame], games: [fakeGame] } as any);

    let restored = false;
    const restore = () => {
        if (restored) return;
        restored = true;
        store.getRunningGames = realGetRunningGames;
        store.getGameForPID = realGetGameForPID;
        FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: [], games: realGetRunningGames.call(store) } as any);
    };
    cleanups.add(restore);

    toast(`${questName(quest)}: pretending to play ${app.name} for ~${Math.ceil((needed - done) / 60)} min`);
    try {
        await waitForHeartbeats(quest, "PLAY_ON_DESKTOP", needed, signal);
    } finally {
        cleanups.delete(restore);
        restore();
    }
}

async function doStream(quest: any, needed: number, done: number, signal: AbortSignal) {
    const store = ApplicationStreamingStore as any;
    const real = store.getStreamerActiveStreamMetadata;
    const pid = Math.floor(Math.random() * 30000) + 1000;
    const appId = getQuestAppId(quest, "STREAM_ON_DESKTOP");
    const spoofed = () => ({ id: appId, pid, sourceName: null });
    store.getStreamerActiveStreamMetadata = spoofed;

    const restore = () => {
        if (store.getStreamerActiveStreamMetadata !== spoofed) return;
        store.getStreamerActiveStreamMetadata = real;
    };
    cleanups.add(restore);

    toast(`${questName(quest)}: start a screen share in a voice channel with at least 1 other person watching. ~${Math.ceil((needed - done) / 60)} min needed.`);
    try {
        await waitForHeartbeats(quest, "STREAM_ON_DESKTOP", needed, signal);
    } finally {
        cleanups.delete(restore);
        restore();
    }
}

async function doActivity(quest: any, needed: number, signal: AbortSignal) {
    const dm = ChannelStore.getSortedPrivateChannels()[0];
    const voice = Object.values(GuildChannelStore.getAllGuilds())
        .find(g => g != null && g.VOCAL?.length > 0)?.VOCAL[0]?.channel;
    const channelId = dm?.id ?? voice?.id;
    if (!channelId) throw new Error("No DM or voice channel available for the activity quest");

    const streamKey = `call:${channelId}:1`;
    let errors = 0;

    while (true) {
        try {
            const res = await request("post", {
                url: `/quests/${quest.id}/heartbeat`,
                body: { stream_key: streamKey, terminal: false }
            }, signal);
            const progress = res?.body?.progress?.PLAY_ACTIVITY?.value ?? 0;
            errors = 0;
            reportProgress(quest, progress, needed);

            if (progress >= needed) {
                await request("post", {
                    url: `/quests/${quest.id}/heartbeat`,
                    body: { stream_key: streamKey, terminal: true }
                }, signal);
                return;
            }
            await sleep(ACTIVITY_HEARTBEAT_INTERVAL, signal);
        } catch (err) {
            if (err instanceof Aborted) throw err;
            if (++errors >= MAX_CONSECUTIVE_ERRORS) throw err;
            logger.error(`${questName(quest)}: heartbeat failed`, err);
            await sleep(ERROR_RETRY_DELAY, signal);
        }
    }
}

async function runQuest(quest: any, signal: AbortSignal) {
    const task = getTaskName(quest)!;
    const needed: number = getTaskConfig(quest).tasks[task].target;
    const done: number = quest.userStatus?.progress?.[task]?.value ?? 0;

    setState({ current: questName(quest), detail: `${Math.floor(done / needed * 100)}%` });
    logger.info(`Starting ${questName(quest)} (${task}) ${done}/${needed}s`);

    switch (task) {
        case "WATCH_VIDEO":
        case "WATCH_VIDEO_ON_MOBILE":
            return doVideo(quest, needed, done, signal);
        case "PLAY_ON_DESKTOP":
            if (!isDesktopApp()) throw new Error("Play quests need the desktop app");
            return doPlay(quest, needed, done, signal);
        case "STREAM_ON_DESKTOP":
            if (!isDesktopApp()) throw new Error("Stream quests need the desktop app");
            return doStream(quest, needed, done, signal);
        case "PLAY_ACTIVITY":
            return doActivity(quest, needed, signal);
    }
}

// ---------------------------------------------------------------- start / stop

async function start() {
    if (state.running) return;

    let quests: any[];
    try {
        quests = getPendingQuests();
    } catch (err) {
        logger.error("Could not read quests", err);
        toast("Couldn't read your quests. Discord probably changed something; check the console.", "critical");
        return;
    }
    if (!quests.length) {
        toast("There are no accepted quests. Accept a quest first in Discover → Quests, then click again.", "critical");
        return;
    }

    const controller = abortController = new AbortController();
    const { signal } = controller;
    setState({ running: true, current: null, detail: "", done: 0, total: quests.length });
    toast(`Activated for ${quests.length} accepted quest${quests.length === 1 ? "" : "s"}: ${quests.map(questName).join(", ")}`, "success");

    let completed = 0;
    try {
        for (const quest of quests) {
            try {
                await runQuest(quest, signal);
                completed++;
                setState({ done: completed });
                toast(`✅ ${questName(quest)} completed`, "success");
            } catch (err) {
                if (err instanceof Aborted) throw err;
                logger.error(`Failed ${questName(quest)}`, err);
                toast(`❌ ${questName(quest)}: ${errorText(err)}`, "critical");
            }
            if (quest !== quests[quests.length - 1]) await sleep(BETWEEN_QUESTS_DELAY, signal);
        }
        toast(`Finished: ${completed}/${quests.length} quest${quests.length === 1 ? "" : "s"} completed. Turned off. Go claim your rewards!`, "success");
    } catch (err) {
        if (!(err instanceof Aborted)) {
            logger.error(err);
            toast(`Stopped because of an error: ${errorText(err)}. Turned off.`, "critical");
        } else toast(`Stopped. ${completed}/${quests.length} completed. Turned off.`);
    } finally {
        if (abortController === controller) abortController = null;
        runCleanups();
        setState({ running: false, current: null, detail: "" });
    }
}

function runCleanups() {
    for (const fn of cleanups) {
        try { fn(); } catch (e) { logger.error("Cleanup failed", e); }
    }
    cleanups.clear();
}

function stop() {
    abortController?.abort();
    runCleanups();
}

function onButtonClick() {
    if (!state.running) return void start();
    Alerts.show({
        title: "Stop completing quests?",
        body: `Currently on: ${state.current ?? "…"} (${state.detail}). Progress already made is kept by Discord.`,
        confirmText: "Stop",
        cancelText: "Keep going",
        onConfirm: stop
    });
}

// ---------------------------------------------------------------- UI

const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

function QuestIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" className={state.running ? "vc-quest-running" : undefined}>
            <path
                fill="currentColor"
                d="M7.5 2A2.5 2.5 0 0 0 5 4.5v15A2.5 2.5 0 0 0 7.5 22h9a2.5 2.5 0 0 0 2.5-2.5v-11L12.5 2h-5ZM12 3.5 17.5 9H13a1 1 0 0 1-1-1V3.5ZM8 13h8v1.5H8V13Zm0 3.5h5V18H8v-1.5Z"
            />
        </svg>
    );
}

function QuestButton(props: { nameplate?: any; }) {
    const s = useRunState();

    const tooltip = s.running
        ? `Quests ON (${s.done}/${s.total}): ${s.current ?? "…"} ${s.detail}. Click to stop.`
        : "Complete accepted quests";

    if (!(PanelButton as any).$$vencordGetWrappedComponent?.()) {
        return (
            <button type="button" className="vc-quest-fallback" title={tooltip} onClick={onButtonClick}>
                <QuestIcon />
            </button>
        );
    }

    return (
        <PanelButton
            tooltipText={tooltip}
            icon={QuestIcon}
            role="switch"
            aria-checked={s.running}
            plated={props?.nameplate != null}
            onClick={onButtonClick}
        />
    );
}

export default definePlugin({
    name: "QuestAutoComplete",
    description: "Adds a button next to Mute/Deafen that completes the Discord quests you have already accepted (video, play, stream and activity quests), then turns itself off.",
    authors: [{ name: "Pargit", id: 786610113447723020n }],
    tags: ["Utility"],
    settings,
    managedStyle,

    patches: [
        {
            // The mic/deafen button row that FakeDeafen and MOM FBI also add to.
            // Captures the buttons other plugins already put there and places ours right after theirs.
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            predicate: () => settings.store.showButton,
            replacement: {
                match: /children:\[((?:Vencord\.Plugins\.plugins\[".+?"\]\.\i\(arguments\[0\]\),)*)(?=\(0,\i\.jsxs?\)\(\i,\{accountContainerRef:)/,
                replace: (_, prepended: string) => {
                    const ours = "$self.QuestButton(arguments[0]),";
                    const calls = prepended.match(/Vencord\.Plugins\.plugins\[".+?"\]\.\w+\(arguments\[0\]\),/g) ?? [];
                    const neighbour = [...calls].reverse().find(c => c.includes('["MOM FBI"]') || c.includes('["FakeDeafen"]'));
                    return neighbour
                        ? `children:[${prepended.replace(neighbour, neighbour + ours)}`
                        : `children:[${ours}${prepended}`;
                }
            }
        }
    ],

    toolboxActions() {
        const s = useRunState();
        return (
            <Menu.MenuItem
                id="vc-quest-auto-complete"
                label={s.running ? `Stop quests (${s.done}/${s.total})` : "Complete accepted quests"}
                action={onButtonClick}
            />
        );
    },

    stop() {
        stop();
    },

    QuestButton: ErrorBoundary.wrap(QuestButton, { noop: true })
});
