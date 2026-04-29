import type { DbClient } from "../../db/client";
import type { ChatMessageEvent } from "../../twitch/types";
import type { Giveaway, GiveawayEntry, GiveawayWinner } from "./giveaways.types";

type StartGiveawayInput = {
  actor: ChatMessageEvent;
  title: string;
  keyword: string;
  winnerCount: number;
};

type DrawResult = {
  giveaway: Giveaway;
  winners: GiveawayWinner[];
  requestedCount: number;
};

export class GiveawaysService {
  constructor(private readonly db: DbClient) {}

  start(input: StartGiveawayInput) {
    const active = this.getActiveGiveaway();

    if (active) {
      throw new Error(`Giveaway #${active.id} is already ${active.status}`);
    }

    const now = timestamp();
    const result = this.db
      .prepare(
        `
          INSERT INTO giveaways (title, keyword, status, winner_count, created_at, opened_at)
          VALUES (@title, @keyword, 'open', @winnerCount, @createdAt, @openedAt)
        `
      )
      .run({
        title: input.title,
        keyword: input.keyword.toLowerCase(),
        winnerCount: input.winnerCount,
        createdAt: now,
        openedAt: now
      });

    const giveaway = this.getGiveawayById(Number(result.lastInsertRowid));

    if (!giveaway) {
      throw new Error("Giveaway was created but could not be read back");
    }

    this.audit(input.actor, "giveaway.start", String(giveaway.id), {
      title: giveaway.title,
      keyword: giveaway.keyword,
      winnerCount: giveaway.winner_count
    });

    return giveaway;
  }

  enter(event: ChatMessageEvent, keyword: string) {
    const giveaway = this.getActiveGiveaway();

    if (!giveaway || giveaway.status !== "open") {
      return { status: "not_open" as const };
    }

    if (keyword.toLowerCase() !== giveaway.keyword) {
      return { status: "ignored" as const };
    }

    const result = this.db
      .prepare(
        `
          INSERT OR IGNORE INTO giveaway_entries
            (giveaway_id, twitch_user_id, login, display_name, entered_at)
          VALUES
            (@giveawayId, @twitchUserId, @login, @displayName, @enteredAt)
        `
      )
      .run({
        giveawayId: giveaway.id,
        twitchUserId: event.chatterUserId,
        login: event.chatterLogin,
        displayName: event.chatterName,
        enteredAt: timestamp()
      });

    return {
      status: result.changes === 1 ? ("entered" as const) : ("duplicate" as const),
      giveaway
    };
  }

  status() {
    const giveaway = this.getActiveGiveaway();

    if (!giveaway) {
      return undefined;
    }

    return {
      giveaway,
      entries: this.countEntries(giveaway.id),
      activeWinners: this.countActiveWinners(giveaway.id),
      rerolledWinners: this.countRerolledWinners(giveaway.id)
    };
  }

  close(actor: ChatMessageEvent) {
    const giveaway = this.requireActiveGiveaway();

    if (giveaway.status === "closed") {
      return giveaway;
    }

    if (giveaway.status !== "open") {
      throw new Error("Only open giveaways can be closed");
    }

    this.db
      .prepare("UPDATE giveaways SET status = 'closed', closed_at = ? WHERE id = ?")
      .run(timestamp(), giveaway.id);

    const closed = this.requireGiveawayById(giveaway.id);
    this.audit(actor, "giveaway.close", String(giveaway.id), {});

    return closed;
  }

  draw(actor: ChatMessageEvent, requestedCount?: number): DrawResult {
    const giveaway = this.requireActiveGiveaway();

    if (giveaway.status === "open") {
      throw new Error("Close the giveaway before drawing winners");
    }

    const remainingWinnerSlots =
      giveaway.winner_count - this.countActiveWinners(giveaway.id);
    const count = Math.max(1, requestedCount ?? remainingWinnerSlots);
    const drawCount = Math.min(count, Math.max(0, remainingWinnerSlots));

    if (drawCount === 0) {
      return { giveaway, winners: [], requestedCount: count };
    }

    const candidates = this.getDrawableEntries(giveaway.id);
    const selected = shuffle(candidates).slice(0, drawCount);
    const winners = selected.map((entry) => this.insertWinner(giveaway.id, entry));

    this.audit(actor, "giveaway.draw", String(giveaway.id), {
      requestedCount: count,
      drawnCount: winners.length,
      winners: winners.map((winner) => winner.login)
    });

    return { giveaway, winners, requestedCount: count };
  }

  reroll(actor: ChatMessageEvent, username: string) {
    const giveaway = this.requireActiveGiveaway();
    const winner = this.findActiveWinner(giveaway.id, username);

    if (!winner) {
      throw new Error(`No active winner found for ${username}`);
    }

    this.db
      .prepare("UPDATE giveaway_winners SET rerolled_at = ? WHERE id = ?")
      .run(timestamp(), winner.id);

    const candidates = this.getDrawableEntries(giveaway.id);
    const replacementEntry = shuffle(candidates)[0];

    const replacement = replacementEntry
      ? this.insertWinner(giveaway.id, replacementEntry)
      : undefined;

    this.audit(actor, "giveaway.reroll", String(giveaway.id), {
      rerolled: winner.login,
      replacement: replacement?.login
    });

    return { giveaway, rerolled: winner, replacement };
  }

  end(actor: ChatMessageEvent) {
    const giveaway = this.requireActiveGiveaway();

    this.db
      .prepare("UPDATE giveaways SET status = 'ended', ended_at = ? WHERE id = ?")
      .run(timestamp(), giveaway.id);

    const ended = this.requireGiveawayById(giveaway.id);
    this.audit(actor, "giveaway.end", String(giveaway.id), {});

    return ended;
  }

  private getActiveGiveaway() {
    return this.db
      .prepare(
        "SELECT * FROM giveaways WHERE status IN ('open', 'closed') ORDER BY id DESC LIMIT 1"
      )
      .get() as Giveaway | undefined;
  }

  private getGiveawayById(id: number) {
    return this.db
      .prepare("SELECT * FROM giveaways WHERE id = ?")
      .get(id) as Giveaway | undefined;
  }

  private requireGiveawayById(id: number) {
    const giveaway = this.getGiveawayById(id);

    if (!giveaway) {
      throw new Error(`Giveaway #${id} was not found`);
    }

    return giveaway;
  }

  private requireActiveGiveaway() {
    const giveaway = this.getActiveGiveaway();

    if (!giveaway) {
      throw new Error("No active giveaway");
    }

    return giveaway;
  }

  private countEntries(giveawayId: number) {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM giveaway_entries WHERE giveaway_id = ?")
      .get(giveawayId) as { count: number };

    return row.count;
  }

  private countActiveWinners(giveawayId: number) {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM giveaway_winners WHERE giveaway_id = ? AND rerolled_at IS NULL"
      )
      .get(giveawayId) as { count: number };

    return row.count;
  }

  private countRerolledWinners(giveawayId: number) {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM giveaway_winners WHERE giveaway_id = ? AND rerolled_at IS NOT NULL"
      )
      .get(giveawayId) as { count: number };

    return row.count;
  }

  private getDrawableEntries(giveawayId: number) {
    return this.db
      .prepare(
        `
          SELECT e.*
          FROM giveaway_entries e
          WHERE e.giveaway_id = ?
            AND NOT EXISTS (
              SELECT 1
              FROM giveaway_winners w
              WHERE w.giveaway_id = e.giveaway_id
                AND w.twitch_user_id = e.twitch_user_id
            )
        `
      )
      .all(giveawayId) as GiveawayEntry[];
  }

  private insertWinner(giveawayId: number, entry: GiveawayEntry) {
    const now = timestamp();
    const result = this.db
      .prepare(
        `
          INSERT INTO giveaway_winners
            (giveaway_id, twitch_user_id, login, display_name, drawn_at)
          VALUES
            (@giveawayId, @twitchUserId, @login, @displayName, @drawnAt)
        `
      )
      .run({
        giveawayId,
        twitchUserId: entry.twitch_user_id,
        login: entry.login,
        displayName: entry.display_name,
        drawnAt: now
      });

    return this.db
      .prepare("SELECT * FROM giveaway_winners WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as GiveawayWinner;
  }

  private findActiveWinner(giveawayId: number, username: string) {
    const normalized = username.replace(/^@/, "").toLowerCase();

    return this.db
      .prepare(
        `
          SELECT *
          FROM giveaway_winners
          WHERE giveaway_id = ?
            AND rerolled_at IS NULL
            AND lower(login) = ?
          LIMIT 1
        `
      )
      .get(giveawayId, normalized) as GiveawayWinner | undefined;
  }

  private audit(
    actor: ChatMessageEvent,
    action: string,
    target: string,
    metadata: Record<string, unknown>
  ) {
    this.db
      .prepare(
        `
          INSERT INTO audit_logs
            (actor_twitch_user_id, action, target, metadata_json, created_at)
          VALUES
            (@actorTwitchUserId, @action, @target, @metadataJson, @createdAt)
        `
      )
      .run({
        actorTwitchUserId: actor.chatterUserId,
        action,
        target,
        metadataJson: JSON.stringify({
          actorLogin: actor.chatterLogin,
          ...metadata
        }),
        createdAt: timestamp()
      });
  }
}

const timestamp = () => new Date().toISOString();

const shuffle = <T>(items: T[]) => {
  const shuffled = [...items];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = shuffled[index];
    const swap = shuffled[swapIndex];

    if (current === undefined || swap === undefined) {
      continue;
    }

    shuffled[index] = swap;
    shuffled[swapIndex] = current;
  }

  return shuffled;
};
