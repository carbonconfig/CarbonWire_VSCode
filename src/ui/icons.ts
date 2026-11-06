import copy from "@vscode/codicons/src/icons/copy.svg";
import lock from "@vscode/codicons/src/icons/lock.svg";
import eye from "@vscode/codicons/src/icons/eye.svg";
import arrowDown from "@vscode/codicons/src/icons/arrow-down.svg";
import layoutPanel from "@vscode/codicons/src/icons/layout-panel.svg";
import arrowUp from "@vscode/codicons/src/icons/arrow-up.svg";
import layoutSidebarRight from "@vscode/codicons/src/icons/layout-sidebar-right.svg";
import circleLarge from "@vscode/codicons/src/icons/circle-large.svg";
import edit from "@vscode/codicons/src/icons/edit.svg";
import listTree from "@vscode/codicons/src/icons/list-tree.svg";
import wand from "@vscode/codicons/src/icons/wand.svg";
import ellipsis from "@vscode/codicons/src/icons/ellipsis.svg";
import unlock from "@vscode/codicons/src/icons/unlock.svg";
import code from "@vscode/codicons/src/icons/code.svg";
import wordWrap from "@vscode/codicons/src/icons/word-wrap.svg";
import passFilled from "@vscode/codicons/src/icons/pass-filled.svg";
import symbolColor from "@vscode/codicons/src/icons/symbol-color.svg";
import trash from "@vscode/codicons/src/icons/trash.svg";
import search from "@vscode/codicons/src/icons/search.svg";
import add from "@vscode/codicons/src/icons/add.svg";
import close from "@vscode/codicons/src/icons/close.svg";
import chevronDown from "@vscode/codicons/src/icons/chevron-down.svg";
import save from "@vscode/codicons/src/icons/save.svg";
import bookmark from "@vscode/codicons/src/icons/bookmark.svg";
import refresh from "@vscode/codicons/src/icons/refresh.svg";
import globe from "@vscode/codicons/src/icons/globe.svg";

/* VS Code's Codicons, inlined as SVG so webviews load no font. */
const ICONS: Record<string, string> = {
	plus: add,
	"right-triangle": chevronDown,
	"more-horizontal": ellipsis,
	pencil: edit,
	circle: circleLarge,
	"circle-dot": passFilled,
	trash,
	x: close,
	"arrow-down": arrowDown,
	"arrow-up": arrowUp,
	"code-xml": code,
	copy,
	eye,
	"list-tree": listTree,
	lock,
	"lock-open": unlock,
	"panel-bottom": layoutPanel,
	"panel-right": layoutSidebarRight,
	pipette: symbolColor,
	search,
	"text-wrap": wordWrap,
	wand,
	save,
	bookmark,
	"refresh-cw": refresh,
	globe,
};

export function iconSvg(name: string): string {
	return ICONS[name] ?? "";
}
