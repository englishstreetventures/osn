import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { resolveDbHandle, streamAccountExport } from "../../src/services/accountExport";
import { createTestLayer, seedChat, seedMember, seedMessage } from "../helpers/db";

const drain = async (
  iter: AsyncIterable<{ section: string; row: Record<string, unknown> }>,
): Promise<Array<{ section: string; row: Record<string, unknown> }>> => {
  const out: Array<{ section: string; row: Record<string, unknown> }> = [];
  for await (const l of iter) out.push(l);
  return out;
};

describe("Zap streamAccountExport", () => {
  it.effect("always emits the ciphertext-excluded advisory line, even with no chats", () =>
    Effect.gen(function* () {
      const db = yield* resolveDbHandle();
      const lines = yield* Effect.promise(() => drain(streamAccountExport(db, [])));
      // Empty profiles still emits the advisory so the bundle is
      // self-documenting.
      expect(lines).toHaveLength(1);
      expect(lines[0]?.section).toBe("zap.chats_advisory");
      expect(lines[0]?.row.excluded).toBe("messages.ciphertext");
      expect(lines[0]?.row.reason).toBe("e2e_encrypted");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("emits chat membership rows but never the message ciphertext", () =>
    Effect.gen(function* () {
      const profileId = "usr_alice";
      const chat = yield* seedChat({ type: "dm", title: "Alice + Bob" });
      yield* seedMember(chat.id, profileId, "admin");
      yield* seedMember(chat.id, "usr_bob", "member");
      // Add a message to verify ciphertext NEVER ends up in the export.
      yield* seedMessage(chat.id, profileId, "ENCRYPTED_PAYLOAD", new Date());

      const db = yield* resolveDbHandle();
      const lines = yield* Effect.promise(() => drain(streamAccountExport(db, [profileId])));

      const chatRows = lines.filter((l) => l.section === "zap.chats");
      expect(chatRows).toHaveLength(1);
      expect(chatRows[0]?.row.profile_id).toBe(profileId);
      expect(chatRows[0]?.row.role).toBe("admin");

      // Hard guarantee: no line in the export contains the ciphertext.
      const text = lines.map((l) => JSON.stringify(l)).join("\n");
      expect(text).not.toContain("ENCRYPTED_PAYLOAD");
      expect(text).not.toContain('ciphertext":"');
    }).pipe(Effect.provide(createTestLayer())),
  );
});
