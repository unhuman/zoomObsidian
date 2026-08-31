import { App, Modal, Setting } from "obsidian";

export class NamePromptModal extends Modal {
  private resolve: (name: string | null) => void;
  private summaryText: string;
  private initialName: string;
  private inputValue: string;

  constructor(
    app: App,
    summaryText: string,
    initialName: string,
    resolve: (name: string | null) => void
  ) {
    super(app);
    this.summaryText = summaryText;
    this.initialName = initialName;
    this.inputValue = initialName;
    this.resolve = resolve;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Identify Meeting Participant" });

    contentEl.createEl("p", {
      text: "Could not automatically identify the other participant. Review the summary below and enter their name:",
    });

    const summaryContainer = contentEl.createDiv({
      cls: "name-prompt-modal-summary",
    });
    summaryContainer.createEl("pre", { text: this.summaryText });

    new Setting(contentEl)
      .setName("Participant Name")
      .setDesc("Full name or identifier")
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
        this.close();
        this.resolve(this.inputValue || null);
      });

    buttonContainer
      .createEl("button", { text: "Cancel" })
      .addEventListener("click", () => {
        this.close();
        this.resolve(null);
      });
  }

  onClose() {
    this.resolve(null);
  }

  static prompt(
    app: App,
    summaryText: string,
    initialName: string
  ): Promise<string | null> {
    return new Promise((resolve) => {
      new NamePromptModal(app, summaryText, initialName, resolve).open();
    });
  }
}
