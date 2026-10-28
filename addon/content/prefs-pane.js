/* global Zotero, document, window */
(function () {
	const PREF = "extensions.claudepaperbuddy.";

	function buddy() {
		return Zotero.ClaudePaperBuddy;
	}

	function provider() {
		return Zotero.Prefs.get(PREF + "provider", true) === "openai" ? "openai" : "anthropic";
	}

	function setStatus(text) {
		let status = document.getElementById("cpb-key-status");
		if (status) status.value = text;
	}

	async function showKey() {
		let input = document.getElementById("cpb-key");
		let key = await buddy().getAPIKey(provider());
		input.value = key;
		let name = provider() === "openai" ? "OpenAI-compatible" : "Anthropic";
		setStatus(key ? `A key is saved for ${name}.` : `No key saved for ${name} yet.`);
	}

	async function saveKey() {
		let input = document.getElementById("cpb-key");
		try {
			await buddy().setAPIKey(provider(), input.value);
			setStatus(input.value.trim() ? "Key saved." : "Key removed.");
		}
		catch (e) {
			Zotero.logError(e);
			setStatus("Couldn't save the key: " + e.message);
		}
	}

	async function testKey() {
		setStatus("Testing…");
		try {
			let result = await buddy().testConnection();
			setStatus(result);
		}
		catch (e) {
			setStatus(e.userMessage || ("Test failed: " + e.message));
		}
	}

	function init() {
		let input = document.getElementById("cpb-key");
		if (!input || input.dataset.cpbInit) return !!input;
		input.dataset.cpbInit = "1";

		document.getElementById("cpb-key-save").addEventListener("command", saveKey);
		document.getElementById("cpb-key-test").addEventListener("command", async () => {
			await saveKey();
			await testKey();
		});
		document.getElementById("cpb-provider").addEventListener("command", () => {
			// The preference updates after the event, so wait a tick
			setTimeout(showKey, 50);
		});

		let system = document.getElementById("cpb-system");
		system.value = Zotero.Prefs.get(PREF + "systemPrompt", true) || "";
		system.placeholder = buddy().DEFAULT_SYSTEM_PROMPT;
		system.addEventListener("change", () => {
			Zotero.Prefs.set(PREF + "systemPrompt", system.value, true);
		});

		showKey();
		return true;
	}

	// The pane's markup may not be in the document yet when this script runs
	let tries = 0;
	(function attempt() {
		if (init() || ++tries > 50) return;
		setTimeout(attempt, 100);
	})();
})();
