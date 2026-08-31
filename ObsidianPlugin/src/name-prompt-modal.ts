import { App, Modal, Setting } from "obsidian";

export class NamePromptModal extends Modal {
  private resolve: (name: string | null) => void;
  private summaryText: string;
  private initialName: string;
  private inputValue: string;
  private existingNames: string[];
  private resolved = false;

  constructor(
    app: App,
    summaryText: string,
    initialName: string,
    existingNames: string[],
    resolve: (name: string | null) => void
  ) {
    super(app);
    this.summaryText = summaryText;
    this.initialName = initialName;
    this.inputValue = initialName;
    this.existingNames = existingNames.sort();
    this.resolve = resolve;
  }

  private resolveOnce(name: string | null) {
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(name);
    }
  }

  onOpen() {
    const { contentEl, modalEl } = this;

    // Disable the default close behavior by removing the close button
    const closeButton = modalEl.querySelector(".modal-close-button");
    if (closeButton) {
      closeButton.remove();
    }

    // Prevent closing by clicking on the background overlay
    const handleBackgroundClick = (e: MouseEvent) => {
      if (e.target === modalEl.parentElement || (e.target as Element)?.classList?.contains("modal-bg")) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    };

    if (modalEl.parentElement) {
      modalEl.parentElement.addEventListener("click", handleBackgroundClick, true);
    }

    contentEl.createEl("h2", { text: "Identify Meeting Participant" });

    contentEl.createEl("p", {
      text: "Could not automatically identify the other participant. Review the summary below and select or enter their name:",
    });

    const summaryContainer = contentEl.createDiv({
      cls: "name-prompt-modal-summary",
    });
    summaryContainer.createEl("pre", { text: this.summaryText });

    // Dropdown for existing 1:1 files
    if (this.existingNames.length > 0) {
      new Setting(contentEl)
        .setName("Select from existing 1:1s")
        .setDesc("Or enter a new name below")
        .addDropdown((dropdown) => {
          dropdown.addOption("", "-- Select a name --");
          for (const name of this.existingNames) {
            dropdown.addOption(name, name);
          }
          dropdown.onChange((value) => {
            if (value) {
              this.inputValue = value;
            }
          });
        });
    }

    // Text input for manual entry or override
    new Setting(contentEl)
      .setName("Participant Name")
      .setDesc("Full name or identifier (or type to override dropdown selection)")
      .addText((text) =>
        text
          .setPlaceholder("Enter name...")
          .setValue(this.inputValue)
          .onChange((value) => {
            this.inputValue = value.trim();
          })
      );

    const buttonContainer = contentEl.createDiv({ cls: "name-prompt-modal-buttons" });
    buttonContainer
      .createEl("button", { text: "Save", cls: "mod-cta" })
      .addEventListener("click", () => {
        this.resolveOnce(this.inputValue || null);
        this.close();
      });

    buttonContainer
      .createEl("button", { text: "Cancel" })
      .addEventListener("click", () => {
        this.resolveOnce(null);
        this.close();
      });
  }

  onClose() {
    this.resolveOnce(null);
  }

  close() {
    // Only allow closing if the modal has been explicitly resolved via a button
    if (this.resolved) {
      super.close();
    }
    // Otherwise, silently ignore the close request
  }

  onEsc() {
    // Override to prevent closing with Escape key
    // User must click Cancel or Save button
    return false;
  }

  static prompt(
    app: App,
    summaryText: string,
    initialName: string,
    existingNames: string[] = []
  ): Promise<string | null> {
    return new Promise((resolve) => {
      new NamePromptModal(app, summaryText, initialName, existingNames, resolve).open();
    });
  }
}
