import pino from "pino";

export type Logger = pino.Logger;

export const createLogger = (level: pino.LevelWithSilent): Logger =>
  pino({
    level,
    base: {
      app: "vaexcore"
    },
    timestamp: pino.stdTimeFunctions.isoTime
  });
