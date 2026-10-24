// bb-plugin-archive-section — moves archived threads into an "Archived"
// sidebar section, and puts them back where they were on unarchive.
//
// Core fires `thread.archived` / `thread.unarchived` after the change lands,
// so the move happens right after the click. Events that fire while the
// plugin is unloaded are not replayed, so a startup sweep catches those up.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Thread = { id: string; sectionId: string | null; title: string | null };
type Section = { id: string; name: string };
/** What a thread's section was before this plugin moved it. */
type Previous = { sectionId: string | null };

const PAGE_SIZE = 200;

/** "🗑️ Archived" and "archived" both normalize to "archived". */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    sectionName: {
      type: "string",
      label: "Archive section name",
      description:
        "Archived threads move into the section with this name. Emoji, spacing and case are ignored when matching, so \"Archived\" finds \"🗑️ Archived\". The section is created if none matches.",
      default: "Archived",
    },
    restoreOnUnarchive: {
      type: "boolean",
      label: "Restore section on unarchive",
      description:
        "When a thread is unarchived, move it back to the section it was in before it was archived.",
      default: true,
    },
  });
  const { sectionName, restoreOnUnarchive } = await settings.get();
  const wanted = sectionName.trim() === "" ? "Archived" : sectionName.trim();

  // Cascade archives fire one event per child at once. Running every
  // change through one queue keeps them from each creating a section.
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  }

  async function listSections(): Promise<Section[]> {
    return await bb.sdk.threadSections.list();
  }

  async function findSection(sections: Section[]): Promise<Section | null> {
    return (
      sections.find((section) => section.name === wanted) ??
      sections.find((section) => normalize(section.name) === normalize(wanted)) ??
      null
    );
  }

  async function archiveSection(): Promise<Section> {
    const existing = await findSection(await listSections());
    if (existing !== null) return existing;
    const created = await bb.sdk.threadSections.create({ name: wanted });
    bb.log.info(`created archive section ${created.name} (${created.id})`);
    return created;
  }

  const previousKey = (threadId: string) => `previous:${threadId}`;

  async function moveToArchive(thread: Thread, section: Section): Promise<boolean> {
    if (thread.sectionId === section.id) return false;
    const previous: Previous = { sectionId: thread.sectionId };
    await bb.storage.kv.set(previousKey(thread.id), previous);
    await bb.sdk.threads.update({ threadId: thread.id, sectionId: section.id });
    bb.log.info(`moved archived thread ${thread.id} into ${section.id}`);
    return true;
  }

  async function restore(thread: Thread): Promise<void> {
    const key = previousKey(thread.id);
    const previous = await bb.storage.kv.get<Previous>(key);
    await bb.storage.kv.delete(key);
    if (!restoreOnUnarchive) return;
    const sections = await listSections();
    const archive = await findSection(sections);
    // Leave the thread alone if the user already moved it somewhere else.
    if (archive === null || thread.sectionId !== archive.id) return;
    const target = previous?.sectionId ?? null;
    const stillExists = target !== null && sections.some((s) => s.id === target);
    await bb.sdk.threads.update({
      threadId: thread.id,
      sectionId: stillExists ? target : null,
    });
    bb.log.info(`restored unarchived thread ${thread.id} to ${stillExists ? target : "no section"}`);
  }

  /** Moves every archived thread that is outside the archive section. */
  async function sweep(): Promise<{ sectionName: string; moved: Thread[] }> {
    const section = await archiveSection();
    const moved: Thread[] = [];
    // Each move takes a thread out of the "not in section" set, so page by
    // offset over the whole archived list instead of a filtered one.
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page: Thread[] = await bb.sdk.threads.list({
        archived: true,
        includeHidden: true,
        limit: PAGE_SIZE,
        offset,
      });
      for (const thread of page) {
        if (await moveToArchive(thread, section)) moved.push(thread);
      }
      if (page.length < PAGE_SIZE) break;
    }
    return { sectionName: section.name, moved };
  }

  bb.events.on("thread.archived", ({ thread }) =>
    serialize(async () => {
      await moveToArchive(thread, await archiveSection());
    }),
  );
  bb.events.on("thread.unarchived", ({ thread }) => serialize(() => restore(thread)));

  bb.background.service("startup-sweep", {
    async start(signal) {
      const { moved } = await serialize(sweep);
      if (moved.length > 0) bb.log.info(`startup sweep moved ${moved.length} thread(s)`);
      // Nothing else to do; stay up until reload so the service is not restarted.
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    },
  });

  const usage = [
    "Usage:",
    "  bb archive-section status [--json]",
    "  bb archive-section sweep [--json]",
  ].join("\n");
  bb.cli.register({
    name: "archive-section",
    summary: "Keep archived threads in an Archived sidebar section",
    commands: [
      {
        name: "status",
        summary: "Show the archive section and how many archived threads are outside it",
        usage: "bb archive-section status [--json]",
      },
      {
        name: "sweep",
        summary: "Move every archived thread that is outside the section into it",
        usage: "bb archive-section sweep [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...rest] = argv.filter((arg) => arg !== "--json");
      if (rest.length > 0) return { exitCode: 1, stderr: usage };
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "status": {
          const section = await findSection(await listSections());
          let outside = 0;
          for (let offset = 0; ; offset += PAGE_SIZE) {
            const page: Thread[] = await bb.sdk.threads.list({
              archived: true,
              includeHidden: true,
              limit: PAGE_SIZE,
              offset,
            });
            outside += page.filter((t) => t.sectionId !== section?.id).length;
            if (page.length < PAGE_SIZE) break;
          }
          const value = {
            sectionName: wanted,
            sectionId: section?.id ?? null,
            restoreOnUnarchive,
            archivedOutsideSection: outside,
          };
          const text = [
            section === null
              ? `Section: none matches "${wanted}" yet (created on the next archive)`
              : `Section: ${section.name} (${section.id})`,
            `Restore on unarchive: ${restoreOnUnarchive ? "on" : "off"}`,
            `Archived threads outside the section: ${outside}`,
          ].join("\n");
          return { exitCode: 0, stdout: json ? JSON.stringify(value) : text };
        }
        case "sweep": {
          const result = await serialize(sweep);
          const text =
            result.moved.length === 0
              ? `Every archived thread is already in ${result.sectionName}.`
              : [
                  `Moved ${result.moved.length} thread(s) into ${result.sectionName}:`,
                  ...result.moved.map((t) => `  ${t.id}  ${t.title ?? "(untitled)"}`),
                ].join("\n");
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify({
                  sectionName: result.sectionName,
                  moved: result.moved.map((t) => ({ id: t.id, title: t.title })),
                })
              : text,
          };
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}
