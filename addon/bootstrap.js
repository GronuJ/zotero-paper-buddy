/* global Zotero, Services, Components */
var chromeHandle;

function install() {}

async function startup({ id, version, rootURI }) {
	await Zotero.initializationPromise;

	var aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
		.getService(Components.interfaces.amIAddonManagerStartup);
	var manifestURI = Services.io.newURI(rootURI + "manifest.json");
	chromeHandle = aomStartup.registerChrome(manifestURI, [
		["content", "claudepaperbuddy", rootURI + "content/"],
	]);

	Services.scriptloader.loadSubScript(rootURI + "content/buddy.js");
	await Zotero.ClaudePaperBuddy.startup({ id, version, rootURI });

	for (let win of Zotero.getMainWindows()) {
		Zotero.ClaudePaperBuddy.onMainWindowLoad(win);
	}
}

function onMainWindowLoad({ window }) {
	Zotero.ClaudePaperBuddy?.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
	Zotero.ClaudePaperBuddy?.onMainWindowUnload(window);
}

function shutdown() {
	if (Zotero.ClaudePaperBuddy) {
		for (let win of Zotero.getMainWindows()) {
			Zotero.ClaudePaperBuddy.onMainWindowUnload(win);
		}
		Zotero.ClaudePaperBuddy.shutdown();
		delete Zotero.ClaudePaperBuddy;
	}
	if (chromeHandle) {
		chromeHandle.destruct();
		chromeHandle = null;
	}
}

function uninstall() {}
