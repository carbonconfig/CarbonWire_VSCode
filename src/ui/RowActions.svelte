<script lang="ts">
	import { icon, openContextMenu } from "./actions";

	let {
		addLabel,
		onEdit,
		editLabel = "Edit",
	}: {
		/** Shows a + button that opens the row's "add" menu (new request, new folder). */
		addLabel?: string;
		onEdit?: () => void;
		editLabel?: string;
	} = $props();
</script>

<!-- Clicks and key presses here must not also toggle or open the row. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="carbonwire-row-actions" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
	{#if addLabel}
		<button class="clickable-icon carbonwire-row-add" aria-label={addLabel} title={addLabel} data-vscode-context={JSON.stringify({ webviewSection: "add" })} onclick={openContextMenu} use:icon={"plus"}></button>
	{/if}
	{#if onEdit}
		<button class="clickable-icon carbonwire-row-edit" aria-label={editLabel} title={editLabel} onclick={onEdit} use:icon={"pencil"}></button>
	{/if}
	<button class="clickable-icon carbonwire-row-more" aria-label="More actions" title="More actions" onclick={openContextMenu} use:icon={"more-horizontal"}></button>
</div>
