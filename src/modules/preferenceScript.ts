import { getPref, setPref } from "../utils/prefs";

type SummaryPrompt = {
  name: string;
  prompt: string;
};

export async function registerPrefsScripts(_window: Window) {
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: _window,
      columns: [],
      rows: [],
    };
  } else {
    addon.data.prefs.window = _window;
  }
  initPromptEditor(_window);
}

function initPromptEditor(win: Window) {
  const doc = win.document;
  const addonRef = addon.data.config.addonRef;
  const list = getElement<HTMLSelectElement>(
    doc,
    `zotero-prefpane-${addonRef}-summary-prompt-list`,
  );
  const nameInput = getElement<HTMLInputElement>(
    doc,
    `zotero-prefpane-${addonRef}-summary-prompt-name`,
  );
  const bodyInput = getElement<HTMLTextAreaElement>(
    doc,
    `zotero-prefpane-${addonRef}-summary-prompt-body`,
  );
  const addButton = getElement<HTMLButtonElement>(
    doc,
    `zotero-prefpane-${addonRef}-summary-prompt-add`,
  );
  const deleteButton = getElement<HTMLButtonElement>(
    doc,
    `zotero-prefpane-${addonRef}-summary-prompt-delete`,
  );
  const hiddenInput = getElement<HTMLTextAreaElement>(
    doc,
    `zotero-prefpane-${addonRef}-summary-prompts`,
  );
  const apiKeyInput = getElement<HTMLInputElement>(
    doc,
    `zotero-prefpane-${addonRef}-openai-api-key`,
  );

  const prompts = loadSummaryPrompts();
  let selectedIndex = prompts.length ? 0 : -1;

  const save = () => {
    const value = JSON.stringify(prompts);
    hiddenInput.value = value;
    setPref("summaryPrompts", value);
  };

  const render = () => {
    list.replaceChildren();
    prompts.forEach((prompt, index) => {
      const option = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "option",
      ) as HTMLOptionElement;
      option.value = String(index);
      option.textContent = prompt.name || "(Untitled)";
      option.selected = index === selectedIndex;
      list.appendChild(option);
    });

    const selected = prompts[selectedIndex];
    nameInput.value = selected?.name ?? "";
    bodyInput.value = selected?.prompt ?? "";
    nameInput.disabled = !selected;
    bodyInput.disabled = !selected;
    deleteButton.disabled = !selected;
    hiddenInput.value = JSON.stringify(prompts);
  };

  list.addEventListener("change", () => {
    selectedIndex = list.selectedIndex;
    render();
  });

  nameInput.addEventListener("input", () => {
    if (!prompts[selectedIndex]) return;
    prompts[selectedIndex].name = nameInput.value;
    save();
    render();
  });

  bodyInput.addEventListener("input", () => {
    if (!prompts[selectedIndex]) return;
    prompts[selectedIndex].prompt = bodyInput.value;
    save();
  });

  addButton.addEventListener("click", () => {
    prompts.push({
      name: "New prompt",
      prompt: "",
    });
    selectedIndex = prompts.length - 1;
    save();
    render();
    nameInput.focus();
    nameInput.select();
  });

  deleteButton.addEventListener("click", () => {
    if (!prompts[selectedIndex]) return;
    if (!win.confirm("Delete the selected summary prompt?")) return;
    prompts.splice(selectedIndex, 1);
    selectedIndex = Math.min(selectedIndex, prompts.length - 1);
    save();
    render();
  });

  apiKeyInput.addEventListener("change", () => {
    const trimmed = apiKeyInput.value.trim();
    apiKeyInput.value = trimmed;
    setPref("openaiApiKey", trimmed);
  });

  render();
}

function loadSummaryPrompts(): SummaryPrompt[] {
  const value = (getPref("summaryPrompts") || "[]") as string;
  try {
    const prompts = JSON.parse(value) as SummaryPrompt[];
    return prompts.filter((prompt) => prompt.name || prompt.prompt);
  } catch {
    return [];
  }
}

function getElement<T extends HTMLElement>(doc: Document, id: string): T {
  const element = doc.getElementById(id);
  if (!element) {
    throw new Error(`Preference element not found: ${id}`);
  }
  return element as T;
}
