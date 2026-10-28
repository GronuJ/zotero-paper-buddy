/* global Zotero, Services, Components, IOUtils, PathUtils */
/* Claude Paper Buddy: ask Claude about highlighted passages in Zotero. */

Zotero.ClaudePaperBuddy = {
	id: null,
	version: null,
	rootURI: null,

	PREF: "extensions.claudepaperbuddy.",
	LOGIN_ORIGIN: "chrome://claudepaperbuddy",
	FTL: "claude-paper-buddy.ftl",
	HTML_NS: "http://www.w3.org/1999/xhtml",
	ANTHROPIC_URL: "https://api.anthropic.com/v1/messages",
	ANTHROPIC_VERSION: "2026-10-21",
	FALLBACK_BETA: "server-side-fallback-2026-07-01",
	FALLBACK_MODELS: ["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"],

	COLORS: {
		"#ffd400": "yellow",
		"#ff6666": "red",
		"#5fb236": "green",
		"#2ea8e5": "blue",
		"#a28ae5": "purple",
		"#e56eee": "magenta",
		"#f19837": "orange",
		"#aaaaaa": "gray",
	},

	DEFAULT_SYSTEM_PROMPT: "You are a research assistant helping a scholar read an academic paper in Zotero. "
		+ "The reader has highlighted a passage and written a question or concern about it in a narrow sidebar. "
		+ "Answer that question directly, grounded in the paper's text, and say plainly when the paper doesn't settle it. "
		+ "Cite page numbers when it helps. Answer in the language the question is written in.",

	LENGTH_INSTRUCTIONS: {
		short: "Keep the answer to 2-4 sentences (under about 80 words) of plain prose: no headings, no lists, no preamble, "
			+ "no restating the question. Give the core answer only; the reader will ask a follow-up if they want more.",
		medium: "Keep the answer under about 150 words. Prefer prose; use a short list only when the answer is genuinely a list. No headings.",
		detailed: "Answer thoroughly, using short lists or headings where they help.",
	},

	// State
	store: { threads: {}, notes: {} },
	storePath: null,
	notifierID: null,
	paneID: null,
	prefPaneID: null,
	sections: new Map(), // section body -> refresh()
	expanded: new Map(), // thread id -> bool, user's choice in this session
	openAnswers: new Set(), // long answers the user expanded
	debounceTimers: new Map(),
	queue: Promise.resolve(),
	inFlight: new Set(),

	// ---------------------------------------------------------------- lifecycle

	async startup({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;

		this.storePath = PathUtils.join(Zotero.DataDirectory.dir, "claude-paper-buddy.json");
		await this.loadStore();

		try {
			Zotero.ftl?.addResourceIds?.([this.FTL]);
		}
		catch (e) {
			Zotero.logError(e);
		}

		this.prefPaneID = await Zotero.PreferencePanes.register({
			pluginID: id,
			src: rootURI + "content/prefs.xhtml",
			scripts: [rootURI + "content/prefs-pane.js"],
			label: "Claude",
			image: "chrome://claudepaperbuddy/content/icons/claude.svg",
		});

		this.registerSection();

		this.notifierID = Zotero.Notifier.registerObserver({
			notify: (event, type, ids, extraData) => this.onNotify(event, type, ids, extraData),
		}, ["item"], "claudePaperBuddy");

		this._onAnnotationMenu = event => this.onAnnotationContextMenu(event);
		Zotero.Reader.registerEventListener("createAnnotationContextMenu", this._onAnnotationMenu, id);
		this._onSelectionPopup = event => this.onTextSelectionPopup(event);
		Zotero.Reader.registerEventListener("renderTextSelectionPopup", this._onSelectionPopup, id);
	},

	shutdown() {
		if (this.notifierID) {
			Zotero.Notifier.unregisterObserver(this.notifierID);
			this.notifierID = null;
		}
		if (this.paneID) {
			Zotero.ItemPaneManager.unregisterSection(this.paneID);
			this.paneID = null;
		}
		if (this._onAnnotationMenu) {
			Zotero.Reader.unregisterEventListener("createAnnotationContextMenu", this._onAnnotationMenu);
		}
		if (this._onSelectionPopup) {
			Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", this._onSelectionPopup);
		}
		for (let timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
		this.sections.clear();
		try {
			Zotero.ftl?.removeResourceIds?.([this.FTL]);
		}
		catch (e) {}
	},

	onMainWindowLoad(win) {
		win.MozXULElement.insertFTLIfNeeded(this.FTL);
		let doc = win.document;
		if (!doc.getElementById("cpb-stylesheet")) {
			let link = doc.createElementNS(this.HTML_NS, "link");
			link.id = "cpb-stylesheet";
			link.rel = "stylesheet";
			link.href = "chrome://claudepaperbuddy/content/panel.css";
			doc.documentElement.appendChild(link);
		}
	},

	onMainWindowUnload(win) {
		win.document.querySelector(`[href="${this.FTL}"]`)?.remove();
		win.document.getElementById("cpb-stylesheet")?.remove();
	},

	// ---------------------------------------------------------------- prefs and keys

	getPref(name) {
		return Zotero.Prefs.get(this.PREF + name, true);
	},

	setPref(name, value) {
		Zotero.Prefs.set(this.PREF + name, value, true);
	},

	get provider() {
		return this.getPref("provider") === "openai" ? "openai" : "anthropic";
	},

	get modelName() {
		return this.provider === "openai"
			? (this.getPref("openaiModel") || "").trim()
			: (this.getPref("anthropicModel") || "claude-opus-5-5").trim();
	},

	get questionColor() {
		return (this.getPref("color") || "#e56eee").toLowerCase();
	},

	async _logins(provider) {
		let all = await Services.logins.getAllLogins();
		return all.filter(l => l.origin === this.LOGIN_ORIGIN && l.httpRealm === provider);
	},

	async getAPIKey(provider = this.provider) {
		let logins = await this._logins(provider);
		return logins.length ? logins[0].password : "";
	},

	async setAPIKey(provider, key) {
		for (let login of await this._logins(provider)) {
			Services.logins.removeLogin(login);
		}
		key = (key || "").trim();
		if (!key) return;
		let info = Components.classes["@mozilla.org/login-manager/loginInfo;1"]
			.createInstance(Components.interfaces.nsILoginInfo);
		info.init(this.LOGIN_ORIGIN, null, provider, "api-key", key, "", "");
		await Services.logins.addLoginAsync(info);
	},

	openPreferences() {
		Zotero.Utilities.Internal.openPreferences(this.prefPaneID);
	},

	// ---------------------------------------------------------------- store

	async loadStore() {
		try {
			if (await IOUtils.exists(this.storePath)) {
				let data = await IOUtils.readJSON(this.storePath);
				this.store = {
					threads: data.threads || {},
					notes: data.notes || {},
				};
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		// Anything that was in flight when Zotero quit didn't finish
		for (let t of Object.values(this.store.threads)) {
			if (t.status === "pending") {
				t.status = "error";
				t.error = "Interrupted. Click Retry to ask again.";
			}
		}
	},

	_saveTimer: null,
	saveStore() {
		if (this._saveTimer) clearTimeout(this._saveTimer);
		this._saveTimer = setTimeout(async () => {
			this._saveTimer = null;
			try {
				await IOUtils.writeJSON(this.storePath, this.store, { tmpPath: this.storePath + ".tmp" });
			}
			catch (e) {
				Zotero.logError(e);
			}
		}, 300);
	},

	threadID(annotation) {
		return annotation.libraryID + "/" + annotation.key;
	},

	getThread(id) {
		return this.store.threads[id] || null;
	},

	changed(thread) {
		if (thread) thread.updatedAt = Date.now();
		this.saveStore();
		this.refreshSections();
	},

	// ---------------------------------------------------------------- triggers

	isQuestion(item) {
		if (!item || !item.isAnnotation?.()) return false;
		if (!["highlight", "underline", "image"].includes(item.annotationType)) return false;
		if ((item.annotationColor || "").toLowerCase() !== this.questionColor) return false;
		return !!(item.annotationComment || "").trim();
	},

	onNotify(event, type, ids, extraData) {
		if (type !== "item") return;
		if (event === "delete") {
			let removed = false;
			for (let id of ids) {
				let data = extraData?.[id];
				if (!data || data.libraryID === undefined || !data.key) continue;
				let tid = data.libraryID + "/" + data.key;
				if (this.store.threads[tid]) {
					let thread = this.store.threads[tid];
					delete this.store.threads[tid];
					this.writeNoteSoon(thread);
					removed = true;
				}
			}
			if (removed) this.changed(null);
			return;
		}
		if (event !== "add" && event !== "modify") return;

		// New or edited question highlights show up in the panel as drafts
		let touchesAnnotations = ids.some(id => Zotero.Items.get(id)?.isAnnotation?.());
		if (touchesAnnotations) this.refreshSoon();
		if (!this.getPref("autoAsk")) return;

		for (let id of ids) {
			let item = Zotero.Items.get(id);
			if (!item || !item.isAnnotation?.()) continue;
			if (!this.isQuestion(item)) continue;
			let existing = this.getThread(this.threadID(item));
			if (existing) continue; // already asked; use Ask again in the panel
			this.scheduleAsk(item.id);
		}
	},

	_refreshTimer: null,
	refreshSoon() {
		if (this._refreshTimer) clearTimeout(this._refreshTimer);
		this._refreshTimer = setTimeout(() => {
			this._refreshTimer = null;
			this.refreshSections();
		}, 400);
	},

	// Question highlights on these attachments that haven't been asked yet
	draftsForItem(item) {
		if (!item) return [];
		let attachments;
		if (item.isRegularItem()) {
			attachments = item.getAttachments().map(id => Zotero.Items.get(id)).filter(Boolean);
		}
		else if (item.isAttachment()) {
			attachments = [item];
		}
		else {
			return [];
		}
		let drafts = [];
		for (let attachment of attachments) {
			if (!attachment.isFileAttachment?.()) continue;
			let annotations;
			try {
				annotations = attachment.getAnnotations();
			}
			catch (e) {
				continue;
			}
			for (let a of annotations) {
				if (this.isQuestion(a) && !this.getThread(this.threadID(a))) drafts.push(a);
			}
		}
		return drafts.sort((a, b) => (a.annotationSortIndex || "").localeCompare(b.annotationSortIndex || ""));
	},

	async askAll(annotations) {
		await Promise.all(annotations.map(a => this.ask(a).catch(e => Zotero.logError(e))));
	},

	// Wait until the comment stops changing before sending it
	scheduleAsk(itemID) {
		let delay = Math.max(1, Number(this.getPref("debounceSeconds")) || 6) * 1000;
		if (this.debounceTimers.has(itemID)) clearTimeout(this.debounceTimers.get(itemID));
		this.debounceTimers.set(itemID, setTimeout(() => {
			this.debounceTimers.delete(itemID);
			let item = Zotero.Items.get(itemID);
			if (!this.isQuestion(item)) return;
			if (this.getThread(this.threadID(item))) return;
			this.ask(item).catch(e => Zotero.logError(e));
		}, delay));
	},

	onAnnotationContextMenu({ reader, params, append }) {
		append({
			label: "Ask Claude",
			onCommand: () => {
				let libraryID = reader._item.libraryID;
				for (let key of params.ids) {
					let item = Zotero.Items.getByLibraryAndKey(libraryID, key);
					if (!item || !item.isAnnotation()) continue;
					this.ask(item, { fresh: true }).catch(e => Zotero.logError(e));
				}
			},
		});
	},

	// "Ask Claude" box in the popup that appears when text is selected in the PDF
	onTextSelectionPopup({ reader, doc, params, append }) {
		let selection = params.annotation;
		if (!selection || !selection.text) return;


		let container = doc.createElement("div");
		// Take the popup's existing width instead of setting one, so its color buttons keep their layout
		container.setAttribute("style", "display: flex; gap: 4px; padding: 6px 0 2px; width: 100%; min-width: 0; max-width: 100%; box-sizing: border-box;");
		let input = doc.createElement("input");
		input.type = "text";
		input.size = 1;
		input.placeholder = "Ask Claude…";
		input.setAttribute("aria-label", "Ask Claude about this selection");
		input.setAttribute("style", "flex: 1 1 0; width: 0; min-width: 0; height: 26px; box-sizing: border-box; padding: 0 8px; "
			+ "border: 1px solid var(--fill-quarternary, #ccc); border-radius: 5px; font: inherit; font-size: 12px; "
			+ "background: var(--material-background, #fff); color: inherit;");
		let button = doc.createElement("button");
		button.textContent = "Ask";
		button.setAttribute("style", `flex: none; height: 26px; padding: 0 10px; border: none; border-radius: 5px; cursor: pointer; `
			+ `font: inherit; font-size: 12px; font-weight: 600; color: #1b1033; background: ${this.questionColor};`);
		container.append(input, button);

		this.fixColorLabels(doc);

		// Copy the selection now; the popup's object goes away when the selection changes
		let json = JSON.parse(JSON.stringify({
			text: selection.text,
			position: selection.position,
			sortIndex: selection.sortIndex,
			pageLabel: selection.pageLabel,
		}));

		let submit = async () => {
			let question = input.value.trim();
			if (!question) return;
			input.disabled = true;
			button.disabled = true;
			try {
				let attachment = Zotero.Items.get(reader.itemID);
				let annotation = await Zotero.Annotations.saveFromJSON(attachment, {
					...json,
					key: Zotero.DataObjectUtilities.generateKey(),
					type: "highlight",
					color: this.questionColor,
					comment: question,
				});
				container.replaceChildren(doc.createTextNode("Asked. The answer appears in the Claude panel."));
				container.style.fontSize = "12px";
				await this.ask(annotation);
			}
			catch (e) {
				Zotero.logError(e);
				container.replaceChildren(doc.createTextNode("Couldn't create the highlight: " + e.message));
			}
		};
		// Keep the reader's own shortcuts from firing while typing
		for (let type of ["keydown", "keyup", "keypress"]) {
			input.addEventListener(type, (e) => {
				e.stopPropagation();
				if (type === "keydown" && e.key === "Enter") {
					e.preventDefault();
					submit();
				}
			});
		}
		input.addEventListener("pointerdown", e => e.stopPropagation());
		button.addEventListener("click", submit);
		append(container);
	},

	// Ethereal Style adds names to the popup's color buttons, but Zotero 10 keeps that popup
	// about 200px wide, so the names get squeezed to one letter per line. Give the buttons
	// room to show each name on one line, as a vertical list.
	fixColorLabels(doc) {
		if (doc.getElementById("cpb-color-labels-v3")) return;
		for (let old of ["cpb-color-labels", "cpb-color-labels-v2"]) doc.getElementById(old)?.remove();
		let style = doc.createElement("style");
		style.id = "cpb-color-labels-v3";
		// One color per line, like a menu, so the popup keeps roughly its normal width
		style.textContent = `
			.selection-popup { min-width: 210px !important; max-width: 240px !important; }
			.selection-popup .colors {
				display: grid !important;
				grid-template-columns: 1fr !important;
				gap: 1px !important;
			}
			.selection-popup .colors > * {
				width: 100% !important;
				min-width: 0 !important;
				max-width: none !important;
				box-sizing: border-box !important;
				height: 24px !important;
				display: inline-flex !important;
				flex-direction: row !important;
				align-items: center !important;
				justify-content: flex-start !important;
				gap: 5px !important;
				padding: 0 8px 0 4px !important;
				border-radius: 5px !important;
				font-size: 12px !important;
				overflow: visible !important;
			}
			.selection-popup .colors > :hover {
				background: var(--fill-quinary, rgba(127, 127, 127, 0.18)) !important;
			}
			.selection-popup .colors > *,
			.selection-popup .colors > * *,
			.selection-popup .colors > *::before,
			.selection-popup .colors > *::after,
			.selection-popup .colors > * *::before,
			.selection-popup .colors > * *::after {
				position: static !important;
				transform: none !important;
				writing-mode: horizontal-tb !important;
				white-space: nowrap !important;
				word-break: normal !important;
				overflow-wrap: normal !important;
				flex-shrink: 0;
			}
			.selection-popup .colors > * :not(svg):not(img):not(svg *),
			.selection-popup .colors > *::before,
			.selection-popup .colors > *::after,
			.selection-popup .colors > * :not(svg):not(svg *)::before,
			.selection-popup .colors > * :not(svg):not(svg *)::after {
				width: auto !important;
				max-width: none !important;
			}
		`;
		(doc.head || doc.documentElement).append(style);
	},

	// ---------------------------------------------------------------- asking

	async ask(annotation, { fresh = false } = {}) {
		let id = this.threadID(annotation);
		let thread = this.getThread(id);
		let comment = (annotation.annotationComment || "").trim();
		let text = (annotation.annotationText || "").trim();
		let attachment = annotation.parentItem;

		if (!thread || fresh) {
			thread = {
				id,
				libraryID: annotation.libraryID,
				annotationKey: annotation.key,
				attachmentKey: attachment.key,
				parentKey: attachment.parentItem ? attachment.parentItem.key : null,
				color: annotation.annotationColor,
				page: annotation.annotationPageLabel || "",
				sortIndex: annotation.annotationSortIndex || "",
				quote: text,
				kind: annotation.annotationType === "image" ? "image" : "text",
				messages: [{
					role: "user",
					content: comment || (annotation.annotationType === "image" ? "Explain this figure." : "Explain this passage."),
				}],
				createdAt: Date.now(),
			};
			this.store.threads[id] = thread;
			this.expanded.set(id, true);
		}
		await this.run(thread);
	},

	async followUp(threadID, question) {
		let thread = this.getThread(threadID);
		question = (question || "").trim();
		if (!thread || !question || thread.status === "pending") return;
		thread.messages.push({ role: "user", content: question });
		this.expanded.set(threadID, true);
		await this.run(thread);
	},

	async retry(threadID) {
		let thread = this.getThread(threadID);
		if (!thread || thread.status === "pending") return;
		// Drop a trailing assistant answer so the last user turn is asked again
		if (thread.messages.length && thread.messages[thread.messages.length - 1].role === "assistant") {
			thread.messages.pop();
		}
		await this.run(thread);
	},

	async askAgain(threadID) {
		let thread = this.getThread(threadID);
		if (!thread || thread.status === "pending") return;
		let annotation = Zotero.Items.getByLibraryAndKey(thread.libraryID, thread.annotationKey);
		if (!annotation) return;
		await this.ask(annotation, { fresh: true });
	},

	// Requests go out one at a time, which keeps rate-limited providers happy
	run(thread) {
		thread.status = "pending";
		thread.error = null;
		this.changed(thread);
		let job = this.queue.then(() => this._run(thread));
		this.queue = job.catch(() => {});
		return job;
	},

	async _run(thread) {
		// The thread may have been deleted while it waited in the queue
		if (this.store.threads[thread.id] !== thread) return;
		try {
			let result = await this.callModelWithRetries(thread);
			let message = { role: "assistant", content: result.text, model: result.model };
			thread.messages.push(message);
			thread.status = "done";
			thread.error = null;
		}
		catch (e) {
			Zotero.logError(e);
			thread.status = "error";
			thread.error = e.userMessage || ("Something went wrong: " + e.message);
		}
		this.changed(thread);
		if (thread.status === "done") {
			this.writeNoteSoon(thread);
		}
	},

	async callModelWithRetries(thread) {
		let attempts = 0;
		while (true) {
			try {
				return await this.callModel(thread);
			}
			catch (e) {
				attempts++;
				if (!e.retryAfter || attempts >= 4) throw e;
				let seconds = Math.min(e.retryAfter, 120);
				thread.error = `${e.userMessage} Trying again in ${seconds} s.`;
				this.changed(thread);
				await Zotero.Promise.delay(seconds * 1000);
				if (this.store.threads[thread.id] !== thread) throw e;
				thread.error = null;
				this.changed(thread);
			}
		}
	},

	// ---------------------------------------------------------------- context

	async buildContext(thread) {
		let attachment = Zotero.Items.getByLibraryAndKey(thread.libraryID, thread.attachmentKey);
		let parent = attachment && attachment.parentItem;
		let meta = [];
		let source = parent || attachment;
		if (source) {
			let title = source.getField("title");
			if (title) meta.push("Title: " + title);
			if (parent) {
				let creators = parent.getCreators().map(c => [c.firstName, c.lastName].filter(Boolean).join(" ")).filter(Boolean);
				if (creators.length) meta.push("Authors: " + creators.join(", "));
				let date = parent.getField("date");
				if (date) meta.push("Date: " + date);
				let pub = parent.getField("publicationTitle");
				if (pub) meta.push("Published in: " + pub);
				let doi = parent.getField("DOI");
				if (doi) meta.push("DOI: " + doi);
				let abstract = parent.getField("abstractNote");
				if (abstract && !this.getPref("fullText")) meta.push("Abstract: " + abstract);
			}
		}

		let paperText = "";
		let note = "";
		if (attachment && this.getPref("fullText")) {
			try {
				paperText = (await attachment.attachmentText) || "";
			}
			catch (e) {
				Zotero.logError(e);
			}
			if (!paperText) {
				note = "(The full text of this paper isn't indexed in Zotero, so only the highlighted passage is available.)";
			}
		}

		let max = Number(this.getPref("maxContextChars")) || 0;
		if (!max) max = this.provider === "anthropic" ? 1500000 : 48000;
		if (paperText.length > max) {
			paperText = this.excerptAround(paperText, thread.quote, max);
			note = "(The paper is long, so this is an excerpt around the highlighted passage, not the whole text.)";
		}

		let parts = [];
		if (meta.length) parts.push("<paper_metadata>\n" + meta.join("\n") + "\n</paper_metadata>");
		if (paperText) parts.push("<paper_text>\n" + paperText + "\n</paper_text>");
		if (note) parts.push(note);
		return parts.join("\n\n") || "(No paper text available.)";
	},

	excerptAround(text, quote, max) {
		let probe = (quote || "").replace(/\s+/g, " ").trim().slice(0, 60);
		let flat = text.replace(/\s+/g, " ");
		let pos = probe ? flat.indexOf(probe) : -1;
		if (pos < 0) return flat.slice(0, max);
		let start = Math.max(0, Math.min(pos - Math.floor(max / 2), flat.length - max));
		return (start > 0 ? "…" : "") + flat.slice(start, start + max) + (start + max < flat.length ? "…" : "");
	},

	questionBlock(thread) {
		let page = thread.page ? ` (page ${thread.page})` : "";
		if (thread.kind === "image") {
			return `The attached image is a region of the paper I selected${page}, such as a figure or table.\n\n`
				+ `My question: ${thread.messages[0].content}`;
		}
		return `I highlighted this passage${page}:\n<highlight>\n${thread.quote || "(no text)"}\n</highlight>\n\n`
			+ `My question: ${thread.messages[0].content}`;
	},

	// ---------------------------------------------------------------- providers

	async callModel(thread) {
		let provider = this.provider;
		let key = await this.getAPIKey(provider);
		if (!key) {
			throw this.userError("Add your API key in Zotero › Settings › Claude first.");
		}
		let model = this.modelName;
		if (!model) {
			throw this.userError("Set a model name in Zotero › Settings › Claude first.");
		}
		let context = await this.buildContext(thread);
		let system = (this.getPref("systemPrompt") || "").trim() || this.DEFAULT_SYSTEM_PROMPT;
		let length = this.LENGTH_INSTRUCTIONS[this.getPref("answerLength")] || this.LENGTH_INSTRUCTIONS.short;
		system += "\n\n" + length;
		let rest = thread.messages.slice(1).map(m => ({ role: m.role, content: m.content }));
		let image = thread.kind === "image" ? await this.annotationImage(thread) : null;

		if (provider === "anthropic") {
			let content = [{ type: "text", text: context, cache_control: { type: "ephemeral" } }];
			if (image) {
				content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: image } });
			}
			content.push({ type: "text", text: this.questionBlock(thread) });
			let messages = [{ role: "user", content }, ...rest];
			return this.callAnthropic({ key, model, system, messages });
		}

		let first = context + "\n\n" + this.questionBlock(thread);
		let messages = [
			{ role: "system", content: system },
			{
				role: "user",
				content: image
					? [
						{ type: "text", text: first },
						{ type: "image_url", image_url: { url: "data:image/png;base64," + image } },
					]
					: first,
			},
			...rest,
		];
		return this.callOpenAI({ key, model, messages });
	},

	// Base64 PNG of an image annotation, from Zotero's annotation image cache
	async annotationImage(thread) {
		let annotation = Zotero.Items.getByLibraryAndKey(thread.libraryID, thread.annotationKey);
		if (!annotation) throw this.userError("This figure annotation no longer exists.");
		let path = Zotero.Annotations.getCacheImagePath(annotation);
		if (!(await IOUtils.exists(path))) {
			try {
				await Zotero.PDFWorker.renderAttachmentAnnotations(annotation.parentItemID);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		if (!(await IOUtils.exists(path))) {
			throw this.userError("Couldn't get the image of this figure. Open the PDF once and try again.");
		}
		let bytes = await IOUtils.read(path);
		let binary = "";
		for (let i = 0; i < bytes.length; i += 0x8000) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		}
		return Zotero.getMainWindow().btoa(binary);
	},

	imageURL(thread) {
		try {
			let path = Zotero.Annotations.getCacheImagePath({ libraryID: thread.libraryID, key: thread.annotationKey });
			return PathUtils.toFileURI(path);
		}
		catch (e) {
			return null;
		}
	},

	async testConnection() {
		let provider = this.provider;
		let key = await this.getAPIKey(provider);
		if (!key) throw this.userError("Save a key first.");
		let model = this.modelName;
		if (!model) throw this.userError("Set a model name first.");
		let messages = [{ role: "user", content: "Reply with the single word OK." }];
		if (provider === "anthropic") {
			await this.callAnthropic({ key, model, system: "You are a connection test.", messages });
		}
		else {
			await this.callOpenAI({ key, model, messages });
		}
		return `It works: ${model} answered.`;
	},

	async callAnthropic({ key, model, system, messages }, useFallbacks = true) {
		let body = {
			model,
			max_tokens: 16000,
			system: [{ type: "text", text: system }],
			messages,
		};
		let effort = this.getPref("effort");
		if (effort && effort !== "default") {
			body.output_config = { effort };
		}
		let headers = {
			"Content-Type": "application/json",
			"x-api-key": key,
			"anthropic-version": this.ANTHROPIC_VERSION,
			"anthropic-dangerous-direct-browser-access": "true",
		};
		let fallbacks = useFallbacks && this.FALLBACK_MODELS.includes(model);
		if (fallbacks) {
			body.fallbacks = "default";
			headers["anthropic-beta"] = this.FALLBACK_BETA;
		}

		let xhr = await this.post(this.ANTHROPIC_URL, headers, body);
		let data = xhr.response;
		if (xhr.status === 400 && fallbacks && /fallback/i.test(JSON.stringify(data || ""))) {
			return this.callAnthropic({ key, model, system, messages }, false);
		}
		if (xhr.status < 200 || xhr.status >= 300) {
			throw this.httpError(xhr, data?.error?.message);
		}
		if (data.stop_reason === "refusal") {
			throw this.userError("Claude declined to answer this question.");
		}
		let text = (data.content || [])
			.filter(b => b.type === "text")
			.map(b => b.text)
			.join("\n\n")
			.trim();
		if (data.stop_reason === "max_tokens") {
			text += "\n\n_(The answer was cut off because it hit the length limit.)_";
		}
		if (!text) throw this.userError("Claude returned an empty answer. Try again.");
		return {
			text,
			model: data.model || model,
		};
	},

	async callOpenAI({ key, model, messages }) {
		let base = (this.getPref("openaiBaseURL") || "").trim().replace(/\/+$/, "");
		if (!base) throw this.userError("Set the base URL in Zotero › Settings › Claude first.");
		let xhr = await this.post(base + "/chat/completions", {
			"Content-Type": "application/json",
			"Authorization": "Bearer " + key,
		}, { model, messages });
		let data = xhr.response;
		if (xhr.status < 200 || xhr.status >= 300) {
			let msg = data?.error?.message || data?.message || data?.detail;
			throw this.httpError(xhr, typeof msg === "string" ? msg : null);
		}
		let text = data?.choices?.[0]?.message?.content || "";
		text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
		if (!text) throw this.userError("The model returned an empty answer. Try again.");
		this.refreshSections();
		return { text, model: data?.model || model };
	},

	async post(url, headers, body) {
		try {
			return await Zotero.HTTP.request("POST", url, {
				headers,
				body: JSON.stringify(body),
				responseType: "json",
				successCodes: false,
				timeout: 10 * 60 * 1000,
				logBodyLength: 0,
			});
		}
		catch (e) {
			if (e instanceof Zotero.HTTP.TimeoutException) {
				throw this.userError("The request timed out. Try again.");
			}
			let err = this.userError("Couldn't reach the API. Check your internet connection.");
			err.retryAfter = 20;
			throw err;
		}
	},

	userError(message) {
		let e = new Error(message);
		e.userMessage = message;
		return e;
	},

	httpError(xhr, apiMessage) {
		let status = xhr.status;
		let message;
		if (status === 401 || status === 403) {
			message = "The API key was rejected. Check it in Zotero › Settings › Claude.";
		}
		else if (status === 429) {
			message = "Rate limit reached.";
		}
		else if (status === 529 || status >= 500) {
			message = "The API is busy or having trouble.";
		}
		else {
			message = `The API returned an error (${status})` + (apiMessage ? `: ${apiMessage}` : ".");
		}
		let e = this.userError(message);
		if (status === 429 || status >= 500) {
			let header = xhr.getResponseHeader?.("retry-after");
			let seconds = parseInt(header, 10);
			e.retryAfter = Number.isFinite(seconds) && seconds > 0 ? seconds : (status === 429 ? 30 : 15);
		}
		return e;
	},

	// ---------------------------------------------------------------- markdown

	escapeHTML(s) {
		return String(s)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	},

	inlineMD(s) {
		s = this.escapeHTML(s);
		s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
		s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
		s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, "$1<em>$2</em>");
		s = s.replace(/(^|[^_\w])_([^_\n]+)_(?=[^_\w]|$)/g, "$1<em>$2</em>");
		s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
		return s;
	},

	markdownToHTML(md) {
		let lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
		let out = [];
		let para = [];
		let list = null;
		let code = null;
		let flushPara = () => {
			if (para.length) out.push("<p>" + para.map(l => this.inlineMD(l)).join("<br/>") + "</p>");
			para = [];
		};
		let flushList = () => {
			if (list) out.push(`<${list.type}>` + list.items.map(i => "<li>" + this.inlineMD(i) + "</li>").join("") + `</${list.type}>`);
			list = null;
		};
		for (let line of lines) {
			if (code) {
				if (/^\s*```/.test(line)) {
					out.push("<pre><code>" + this.escapeHTML(code.join("\n")) + "</code></pre>");
					code = null;
				}
				else {
					code.push(line);
				}
				continue;
			}
			if (/^\s*```/.test(line)) {
				flushPara();
				flushList();
				code = [];
				continue;
			}
			let m;
			if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/))) {
				flushPara();
				flushList();
				let level = Math.min(6, m[1].length + 2);
				out.push(`<h${level}>${this.inlineMD(m[2])}</h${level}>`);
			}
			else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
				flushPara();
				if (!list || list.type !== "ul") {
					flushList();
					list = { type: "ul", items: [] };
				}
				list.items.push(m[1]);
			}
			else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
				flushPara();
				if (!list || list.type !== "ol") {
					flushList();
					list = { type: "ol", items: [] };
				}
				list.items.push(m[1]);
			}
			else if ((m = line.match(/^\s*>\s?(.*)$/))) {
				flushPara();
				flushList();
				out.push("<blockquote><p>" + this.inlineMD(m[1]) + "</p></blockquote>");
			}
			else if (!line.trim()) {
				flushPara();
				flushList();
			}
			else {
				flushList();
				para.push(line);
			}
		}
		if (code) out.push("<pre><code>" + this.escapeHTML(code.join("\n")) + "</code></pre>");
		flushPara();
		flushList();
		return out.join("\n");
	},

	// ---------------------------------------------------------------- note

	_noteTimers: new Map(),
	writeNoteSoon(thread) {
		if (!this.getPref("writeNote") || !thread.parentKey) return;
		let key = thread.libraryID + "/" + thread.parentKey;
		if (this._noteTimers.has(key)) clearTimeout(this._noteTimers.get(key));
		this._noteTimers.set(key, setTimeout(() => {
			this._noteTimers.delete(key);
			this.writeNote(thread.libraryID, thread.parentKey).catch(e => Zotero.logError(e));
		}, 500));
	},

	openPDFURI(thread, attachmentKey) {
		let lib = Zotero.Libraries.get(thread.libraryID);
		let prefix = lib && lib.libraryType === "group" ? `groups/${lib.groupID}` : "library";
		let page = thread.page ? `page=${encodeURIComponent(thread.page)}&` : "";
		return `zotero://open-pdf/${prefix}/items/${attachmentKey}?${page}annotation=${thread.annotationKey}`;
	},

	async writeNote(libraryID, parentKey) {
		let parent = Zotero.Items.getByLibraryAndKey(libraryID, parentKey);
		if (!parent || !parent.isRegularItem()) return;
		let threads = Object.values(this.store.threads)
			.filter(t => t.libraryID === libraryID && t.parentKey === parentKey
				&& t.messages.some(m => m.role === "assistant"))
			.sort((a, b) => (a.sortIndex || "").localeCompare(b.sortIndex || "") || a.createdAt - b.createdAt);

		let storeKey = libraryID + "/" + parentKey;
		let noteKey = this.store.notes[storeKey];
		let note = noteKey ? Zotero.Items.getByLibraryAndKey(libraryID, noteKey) : null;
		if (note && (note.deleted || note.parentKey !== parentKey)) note = null;

		if (!threads.length) {
			if (note) {
				note.setNote(this.noteHTML([], parent));
				await note.saveTx();
			}
			return;
		}

		let html = this.noteHTML(threads, parent);
		if (!note) {
			note = new Zotero.Item("note");
			note.libraryID = libraryID;
			note.parentKey = parentKey;
		}
		note.setNote(html);
		await note.saveTx();
		this.store.notes[storeKey] = note.key;
		this.saveStore();
	},

	noteHTML(threads, parent) {
		let parts = ["<h1>Claude Q&amp;A</h1>"];
		parts.push("<p><em>Written by Claude Paper Buddy. It is rewritten whenever an answer changes, so edits here will be lost.</em></p>");
		for (let t of threads) {
			parts.push(`<h2>${t.page ? "Page " + this.escapeHTML(t.page) : "Highlight"}</h2>`);
			if (t.kind === "image") parts.push("<p><em>(Question about a figure or table)</em></p>");
			else if (t.quote) parts.push(`<blockquote><p>${this.escapeHTML(t.quote)}</p></blockquote>`);
			parts.push(`<p><a href="${this.escapeHTML(this.openPDFURI(t, t.attachmentKey))}">Show in PDF</a></p>`);
			for (let m of t.messages) {
				if (m.role === "user") {
					parts.push(`<p><strong>You:</strong> ${this.escapeHTML(m.content)}</p>`);
				}
				else {
					parts.push("<p><strong>Claude:</strong></p>");
					parts.push(this.markdownToHTML(m.content));
				}
			}
			parts.push("<hr/>");
		}
		return '<div data-schema-version="9">' + parts.join("\n") + "</div>";
	},

	// ---------------------------------------------------------------- panel

	registerSection() {
		let icon = "chrome://claudepaperbuddy/content/icons/claude.svg";
		this.paneID = Zotero.ItemPaneManager.registerSection({
			paneID: "claude-qa",
			pluginID: this.id,
			header: { l10nID: "cpb-section-header", icon },
			sidenav: { l10nID: "cpb-section-sidenav", icon },
			sectionButtons: [
				{
					type: "cpb-settings",
					icon: "chrome://claudepaperbuddy/content/icons/settings.svg",
					l10nID: "cpb-section-settings",
					onClick: () => this.openPreferences(),
				},
			],
			onInit: ({ body, refresh }) => {
				this.sections.set(body, refresh);
			},
			onDestroy: ({ body }) => {
				this.sections.delete(body);
			},
			onItemChange: ({ item, setEnabled }) => {
				let ok = !!item && (item.isRegularItem() || item.isPDFAttachment?.() || item.isFileAttachment?.());
				setEnabled(ok);
				return true;
			},
			onRender: ({ body, item, setSectionSummary }) => {
				try {
					this.render(body, item, setSectionSummary);
				}
				catch (e) {
					Zotero.logError(e);
				}
			},
		});
	},

	refreshSections() {
		for (let refresh of this.sections.values()) {
			try {
				refresh();
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
	},

	threadsForItem(item) {
		if (!item) return [];
		let keys;
		if (item.isRegularItem()) {
			keys = new Set(item.getAttachments().map(id => Zotero.Items.get(id)).filter(Boolean).map(a => a.key));
		}
		else if (item.isAttachment()) {
			keys = new Set([item.key]);
		}
		else {
			return [];
		}
		return Object.values(this.store.threads)
			.filter(t => t.libraryID === item.libraryID && keys.has(t.attachmentKey))
			.sort((a, b) => (a.sortIndex || "").localeCompare(b.sortIndex || "") || a.createdAt - b.createdAt);
	},

	isExpanded(thread, newestID) {
		if (this.expanded.has(thread.id)) return this.expanded.get(thread.id);
		return thread.status !== "done" || thread.id === newestID;
	},

	render(body, item, setSectionSummary) {
		let doc = body.ownerDocument;
		let h = (tag, attrs = {}, ...children) => {
			let el = doc.createElementNS(this.HTML_NS, tag);
			for (let [k, v] of Object.entries(attrs)) {
				if (v === null || v === undefined || v === false) continue;
				if (k === "class") el.className = v;
				else if (k === "style") el.setAttribute("style", v);
				else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
				else el.setAttribute(k, v === true ? "" : v);
			}
			for (let c of children.flat()) {
				if (c === null || c === undefined || c === false) continue;
				el.append(typeof c === "string" ? doc.createTextNode(c) : c);
			}
			return el;
		};

		let threads = this.threadsForItem(item);
		let drafts = this.draftsForItem(item);
		let answered = threads.filter(t => t.status === "done").length;
		let asking = threads.filter(t => t.status === "pending").length;
		let failed = threads.filter(t => t.status === "error").length;
		let summary = [
			drafts.length ? `${drafts.length} ready` : null,
			answered ? `${answered} answered` : null,
			asking ? `${asking} asking` : null,
			failed ? `${failed} failed` : null,
		].filter(Boolean).join(" · ");
		setSectionSummary?.(summary);

		let color = this.questionColor;
		let colorName = this.COLORS[color] || "your question color";
		let root = h("div", { class: "cpb-root" });

		if (drafts.length) {
			root.append(h("div", { class: "cpb-ready-bar" },
				h("span", { class: "cpb-ready-text" },
					drafts.length === 1 ? "1 question ready" : `${drafts.length} questions ready`),
				h("button", {
					class: "cpb-ask",
					style: `background: ${color}`,
					onclick: () => this.askAll(drafts),
				}, drafts.length === 1 ? "Ask" : "Ask all")));
		}

		if (!threads.length && !drafts.length) {
			root.append(h("div", { class: "cpb-empty" },
				h("span", { class: "cpb-swatch", style: `background: ${color}40; border-bottom-color: ${color}` }),
				h("div", { class: "cpb-empty-title" }, "No questions on this paper yet"),
				h("div", { class: "cpb-empty-text" },
					`Highlight a passage in ${colorName} and write your question in the comment. It shows up here, ready to ask.`)
			));
		}
		else {
			let newest = threads.length
				? threads.reduce((a, b) => ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a))
				: null;
			let entries = [
				...drafts.map(a => ({ sort: a.annotationSortIndex || "", draft: a })),
				...threads.map(t => ({ sort: t.sortIndex || "", thread: t })),
			].sort((a, b) => a.sort.localeCompare(b.sort));
			let list = h("div", { class: "cpb-list" });
			for (let e of entries) {
				list.append(e.draft
					? this.renderDraft(h, e.draft)
					: this.renderThread(h, doc, e.thread, this.isExpanded(e.thread, newest.id)));
			}
			root.append(list);
		}

		let providerLabel = this.provider === "anthropic" ? this.modelName : `${this.modelName} (OpenAI-compatible)`;
		root.append(h("div", { class: "cpb-footer" },
			h("span", { class: "cpb-dot", style: `background: ${color}` }),
			h("span", {}, this.getPref("autoAsk")
				? `${colorName[0].toUpperCase() + colorName.slice(1)} highlights with a comment are asked automatically · ${providerLabel}`
				: `${colorName[0].toUpperCase() + colorName.slice(1)} highlights with a comment appear here, ready to ask · ${providerLabel}`)
		));

		body.replaceChildren(root);
	},

	renderDraft(h, a) {
		let color = a.annotationColor || this.questionColor;
		let card = h("div", { class: "cpb-card cpb-draft" });
		card.append(h("div", { class: "cpb-head" },
			h("span", { class: "cpb-dot", style: `background: ${color}` }),
			h("span", { class: "cpb-page" }, a.annotationPageLabel ? `Page ${a.annotationPageLabel}` : "Highlight"),
			h("span", { class: "cpb-spacer" }),
			h("span", { class: "cpb-status" }, "Not asked yet")));
		if (a.annotationType === "image") {
			let src = this.imageURL({ libraryID: a.libraryID, annotationKey: a.key });
			if (src) card.append(h("img", { class: "cpb-figure", src, alt: "Selected figure" }));
		}
		else if (a.annotationText) {
			card.append(h("div", { class: "cpb-quote", style: `border-left-color: ${color}` }, a.annotationText));
		}
		card.append(h("div", { class: "cpb-msg cpb-user" },
			h("span", { class: "cpb-who" }, "You "), (a.annotationComment || "").trim()));
		card.append(h("div", { class: "cpb-actions" },
			h("button", {
				class: "cpb-ask",
				style: `background: ${this.questionColor}`,
				onclick: () => this.ask(a).catch(e => Zotero.logError(e)),
			}, "Ask")));
		return card;
	},

	renderThread(h, doc, t, expanded) {
		let firstQuestion = t.messages[0]?.content || "";
		let dot = h("span", { class: "cpb-dot", style: `background: ${t.color || this.questionColor}` });
		let pageLabel = t.page ? `Page ${t.page}` : "Highlight";

		if (!expanded) {
			let status = t.status === "pending" ? "Asking…" : t.status === "error" ? "Failed" : "";
			return h("button", {
				class: "cpb-card cpb-collapsed",
				title: firstQuestion,
				onclick: () => {
					this.expanded.set(t.id, true);
					this.refreshSections();
				},
			},
			dot,
			h("span", { class: "cpb-page" }, pageLabel),
			h("span", { class: "cpb-oneline" }, firstQuestion),
			status ? h("span", { class: "cpb-status" }, status) : null,
			h("span", { class: "cpb-chevron", "aria-hidden": "true" }, "›"));
		}

		let card = h("div", { class: "cpb-card" + (t.status === "pending" ? " cpb-active" : "") });
		card.append(h("div", { class: "cpb-head" },
			dot,
			h("span", { class: "cpb-page" }, pageLabel),
			h("span", { class: "cpb-spacer" }),
			h("a", {
				href: "#",
				class: "cpb-link",
				onclick: (e) => {
					e.preventDefault();
					this.showInPDF(t);
				},
			}, "Show in PDF"),
			h("button", {
				class: "cpb-icon-button",
				title: "Collapse",
				"aria-label": "Collapse",
				onclick: () => {
					this.expanded.set(t.id, false);
					this.refreshSections();
				},
			}, "–")
		));

		if (t.kind === "image") {
			let src = this.imageURL(t);
			if (src) card.append(h("img", { class: "cpb-figure", src, alt: "Selected figure" }));
		}
		else if (t.quote) {
			card.append(h("div", { class: "cpb-quote", style: `border-left-color: ${t.color || this.questionColor}` }, t.quote));
		}

		t.messages.forEach((m, i) => {
			if (m.role === "user") {
				card.append(h("div", { class: "cpb-msg cpb-user" + (i > 0 ? " cpb-followup" : "") },
					h("span", { class: "cpb-who" }, "You "), m.content));
			}
			else {
				let answer = h("div", { class: "cpb-msg cpb-answer" });
				answer.append(h("span", { class: "cpb-who cpb-claude" }, "Claude "));
				let md = this.htmlFragment(doc, this.markdownToHTML(m.content));
				answer.append(md);
				// Long answers start clamped, with a toggle
				if (m.content.length > 600) {
					let key = t.id + "#" + i;
					let open = this.openAnswers.has(key);
					if (!open) answer.classList.add("cpb-clamped");
					card.append(answer);
					card.append(h("a", {
						href: "#",
						class: "cpb-link cpb-more",
						onclick: (e) => {
							e.preventDefault();
							if (open) this.openAnswers.delete(key);
							else this.openAnswers.add(key);
							this.refreshSections();
						},
					}, open ? "Show less" : "Show more"));
					return;
				}
				card.append(answer);
			}
		});

		if (t.status === "pending") {
			card.append(h("div", { class: "cpb-pending" },
				h("span", { class: "cpb-spinner", style: `border-top-color: ${this.questionColor}` }),
				t.error ? t.error : "Asking…"));
		}
		else if (t.status === "error") {
			card.append(h("div", { class: "cpb-error" }, t.error || "Something went wrong."));
			card.append(h("div", { class: "cpb-actions" },
				h("button", { class: "cpb-button", onclick: () => this.retry(t.id) }, "Retry"),
				/API key|model name|base URL/.test(t.error || "")
					? h("button", { class: "cpb-button", onclick: () => this.openPreferences() }, "Open settings")
					: null));
		}
		else if (t.status === "done") {
			let input = h("input", {
				class: "cpb-input",
				type: "text",
				placeholder: "Ask a follow-up…",
				"aria-label": "Follow-up question",
			});
			let send = () => {
				let v = input.value;
				if (!v.trim()) return;
				input.value = "";
				this.followUp(t.id, v).catch(e => Zotero.logError(e));
			};
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.shiftKey) {
					e.preventDefault();
					send();
				}
			});
			card.append(h("div", { class: "cpb-compose" },
				input,
				h("button", {
					class: "cpb-send",
					style: `background: ${this.questionColor}`,
					title: "Send",
					"aria-label": "Send follow-up",
					onclick: send,
				}, "↑")));
			let last = [...t.messages].reverse().find(m => m.role === "assistant");
			card.append(h("div", { class: "cpb-actions cpb-small" },
				h("a", {
					href: "#",
					class: "cpb-link",
					onclick: (e) => {
						e.preventDefault();
						this.askAgain(t.id);
					},
				}, "Ask again"),
				last ? h("a", {
					href: "#",
					class: "cpb-link",
					onclick: (e) => {
						e.preventDefault();
						Zotero.Utilities.Internal.copyTextToClipboard(last.content);
					},
				}, "Copy answer") : null,
				h("a", {
					href: "#",
					class: "cpb-link",
					onclick: (e) => {
						e.preventDefault();
						this.removeThread(t.id);
					},
				}, "Remove")));
		}
		return card;
	},

	htmlFragment(doc, html) {
		let parsed = new doc.defaultView.DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
		let wrapper = doc.importNode(parsed.body.firstChild, true);
		wrapper.className = "cpb-md";
		// Open links in the system browser instead of inside Zotero
		for (let a of wrapper.querySelectorAll("a")) {
			let href = a.getAttribute("href");
			a.addEventListener("click", (e) => {
				e.preventDefault();
				if (href) Zotero.launchURL(href);
			});
		}
		return wrapper;
	},

	removeThread(threadID) {
		let thread = this.getThread(threadID);
		if (!thread) return;
		delete this.store.threads[threadID];
		this.expanded.delete(threadID);
		this.changed(null);
		this.writeNoteSoon(thread);
	},

	async showInPDF(thread) {
		let attachment = Zotero.Items.getByLibraryAndKey(thread.libraryID, thread.attachmentKey);
		if (!attachment) return;
		await Zotero.Reader.open(attachment.id, { annotationID: thread.annotationKey });
	},
};
