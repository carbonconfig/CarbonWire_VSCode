<script lang="ts">
	import { untrack } from "svelte";
	import { SvelteSet } from "svelte/reactivity";
	import type { HistoryEntry } from "../core/history";
	import { filterCollections } from "../core/storage/tree";
	import { icon } from "./actions";
	import CollectionsTree from "./CollectionsTree.svelte";
	import type { TreeDrop } from "./drag";
	import EnvironmentsPanel from "./EnvironmentsPanel.svelte";
	import HistoryPanel from "./HistoryPanel.svelte";
	import type { SavedSidebar, SidebarState } from "./sidebar-protocol";

	let {
		initial,
		saved,
		onSave,
		onOpen,
		onNewCollection,
		onNewEnvironment,
		onEditGlobals,
		onOpenFolder,
		onSelectEnvironment,
		onEditEnvironment,
		onMove,
		onMoveCollection,
		onMoveEnvironment,
		onShowHistory,
		onOpenHistory,
		onClearHistory,
	}: {
		initial: SidebarState;
		saved: SavedSidebar | undefined;
		onSave: (state: SavedSidebar) => void;
		onOpen: (path: string) => void;
		onNewCollection: () => void;
		onNewEnvironment: () => void;
		onEditGlobals?: () => void;
		onOpenFolder: () => void;
		onSelectEnvironment: (name: string) => void;
		onEditEnvironment: (path: string) => void;
		onMove: TreeDrop["move"];
		onMoveCollection: TreeDrop["moveCollection"];
		onMoveEnvironment: (path: string, anchor: string, position: "before" | "after") => void;
		/** Called when History is shown and hasn't loaded yet. */
		onShowHistory: () => void;
		onOpenHistory: (entry: HistoryEntry) => void;
		onClearHistory: () => void;
	} = $props();

	const first = untrack(() => initial);
	const kept = untrack(() => saved);
	let current = $state.raw(first);
	let activeName = $state(first.activeEnvironment);
	let activePath = $state<string | undefined>(first.activePath);
	let query = $state("");
	let search = $state<HTMLInputElement>();
	let mode = $state<"collections" | "history">(kept?.mode ?? "collections");
	let history = $state.raw<readonly HistoryEntry[] | undefined>();
	const expanded = new SvelteSet<string>(kept?.expanded ?? first.collections.map((c) => `collection:${c.root}`));

	const visible = $derived(filterCollections(current.collections, query));
	const active = $derived(current.environments.some((e) => e.name === activeName) ? activeName : "");
	const drop: TreeDrop = $derived({ enabled: query.trim() === "", move: onMove, moveCollection: onMoveCollection });

	$effect(() => onSave({ expanded: [...expanded], mode }));
	$effect(() => {
		if (mode === "history" && history === undefined) untrack(onShowHistory);
	});

	export function update(next: SidebarState) {
		current = next;
		activeName = next.activeEnvironment;
	}

	export function setActive(path: string | undefined) {
		activePath = path;
	}

	export function environmentChanged(name: string) {
		activeName = name;
	}

	export function setHistory(entries: readonly HistoryEntry[]) {
		history = entries;
	}

	export function collapseAll() {
		expanded.clear();
	}

	export function reveal(root: string) {
		query = "";
		mode = "collections";
		expanded.add(`collection:${root}`);
	}

	if (first.reveal !== undefined) reveal(first.reveal);
</script>

{#if !current.hasWorkspace}
	<div class="carbonwire-empty carbonwire-no-workspace">
		<p>Open a folder to keep API collections in it. Collections are plain YAML files you can commit with your code.</p>
		<button class="mod-cta" onclick={onOpenFolder}>Open folder</button>
	</div>
{:else}
	<div class="carbonwire-sidebar">
		<div class="carbonwire-topbar">
			<div class="search-input-container carbonwire-search">
				<input
					bind:this={search}
					type="search"
					placeholder={mode === "history" ? "Filter history" : "Filter requests"}
					spellcheck="false"
					aria-label={mode === "history" ? "Filter history" : "Filter requests"}
					bind:value={query}
					onkeydown={(e) => e.key === "Escape" && (query = "")}
				/>
				{#if query}
					<button
						class="clickable-icon search-input-clear-button"
						aria-label="Clear filter"
						onclick={() => {
							query = "";
							search?.focus();
						}}
						use:icon={"x"}
					></button>
				{/if}
			</div>
		</div>

		<section class="carbonwire-section is-collections">
			<header class="carbonwire-section-header">
				<div class="carbonwire-section-tabs" role="tablist">
					<button role="tab" aria-selected={mode === "collections"} class:is-active={mode === "collections"} onclick={() => (mode = "collections")}>Collections</button>
					<button role="tab" aria-selected={mode === "history"} class:is-active={mode === "history"} onclick={() => (mode = "history")}>History</button>
				</div>
				{#if mode === "history"}
					<button class="clickable-icon" aria-label="Clear history" title="Clear history" disabled={!history?.length} onclick={onClearHistory} use:icon={"trash"}></button>
				{/if}
			</header>
			<div class="carbonwire-section-body">
				{#if mode === "history"}
					<HistoryPanel entries={history} {query} onOpen={onOpenHistory} />
				{:else}
					<CollectionsTree collections={visible} {expanded} filtering={query.trim() !== ""} {activePath} {drop} {onOpen} {onNewCollection} />
				{/if}
			</div>
		</section>

		<section class="carbonwire-section is-environments">
			<header class="carbonwire-section-header">
				<span class="carbonwire-section-title">Environments</span>
				<button class="clickable-icon" aria-label="New environment" title="New environment" onclick={onNewEnvironment} use:icon={"plus"}></button>
			</header>
			<div class="carbonwire-section-body">
				<EnvironmentsPanel
					environments={current.environments}
					{active}
					emptyHint="No environments yet. The active one applies to every collection."
					onSelect={onSelectEnvironment}
					onEdit={onEditEnvironment}
					onMove={onMoveEnvironment}
					{onEditGlobals}
				/>
			</div>
		</section>
	</div>
{/if}
