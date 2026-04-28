import type { Logger } from "./logger";

type StartupChecklistOptions = {
  logger: Logger;
};

export class StartupChecklist {
  constructor(private readonly options: StartupChecklistOptions) {}

  pass(item: string, metadata?: Record<string, unknown>) {
    this.options.logger.info(
      {
        check: item,
        ok: true,
        ...metadata
      },
      `Startup checklist: ${item}`
    );
  }
}
