import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUBRIC } from '../rubric.js';

/**
 * The agent skills in `.claude/skills` are documentation that an agent acts on,
 * which makes a stale one worse than a missing one: it will confidently point
 * someone at a check that no longer exists, or a file that moved.
 *
 * This repo's own rule is that a claim nobody verifies should not be made. That
 * applies to prose the same way it applies to code, so the skills are held to
 * the parts of themselves that are mechanically checkable: their frontmatter,
 * the files they cite, and the identifiers they name.
 */
const ROOT = new URL('../../../../', import.meta.url).pathname;
const SKILLS = join(ROOT, '.claude/skills');

function skillFiles(): Array<{ name: string; text: string }> {
  return readdirSync(SKILLS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, text: readFileSync(join(SKILLS, e.name, 'SKILL.md'), 'utf8') }));
}

const skills = skillFiles();
const checkSource = readFileSync(join(ROOT, 'packages/shared/src/checks.ts'), 'utf8');
const realChecks = new Set([...checkSource.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]!));

describe('agent skills', () => {
  it('ships at least the three voice skills', () => {
    // Containment rather than equality: the name of this test says "at least",
    // and an assertion that disagrees with its own name is a trap for whoever
    // adds the next skill. Every skill is still held to the rules below.
    const names = skills.map((s) => s.name);
    for (const required of ['voice-checks', 'voice-evals', 'voice-pipeline']) {
      expect(names).toContain(required);
    }
  });

  for (const skill of skills) {
    describe(skill.name, () => {
      it('has frontmatter whose name matches its directory', () => {
        const front = /^---\n(.*?)\n---\n/s.exec(skill.text);
        expect(front).not.toBeNull();
        expect(front![1]).toContain(`name: ${skill.name}`);
      });

      // The description is the only thing an agent sees when deciding whether
      // the skill is relevant. A vague one means it never loads.
      it('has a description long enough to be a trigger', () => {
        const description = /^description: (.+)$/m.exec(skill.text)?.[1] ?? '';
        expect(description.length).toBeGreaterThan(80);
        expect(description.toLowerCase()).toMatch(/use when/);
      });

      it('cites only files that exist', () => {
        const cited = [...skill.text.matchAll(/`((?:packages|evals|docs)\/[\w./-]+)`/g)].map(
          (m) => m[1]!,
        );
        expect(cited.length).toBeGreaterThan(0);
        for (const path of cited) {
          expect(() => readFileSync(join(ROOT, path), 'utf8'), path).not.toThrow();
        }
      });

      it('names only checks that exist', () => {
        const named = [...skill.text.matchAll(/`(not_\w+|asks_a_question|speakable|single_question|interviewer_register)`/g)]
          .map((m) => m[1]!)
          .filter((n) => n !== 'not_verified');
        for (const name of named) expect(realChecks, name).toContain(name);
      });
    });
  }

  it('does not name a rubric dimension that was removed', () => {
    const ids = new Set(RUBRIC.map((d) => d.id as string));
    for (const skill of skills) {
      for (const m of skill.text.matchAll(/\bid: '([a-z_]+)'/g)) {
        expect(ids, `${skill.name} names rubric dimension ${m[1]}`).toContain(m[1]!);
      }
    }
  });

  // The commands are the part someone will paste. A renamed script would make
  // the skill actively misleading rather than merely dated.
  it('only tells people to run scripts that exist', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const skill of skills) {
      for (const m of skill.text.matchAll(/^pnpm ([a-z:]+)$/gm)) {
        expect(Object.keys(pkg.scripts), `${skill.name} runs "pnpm ${m[1]}"`).toContain(m[1]!);
      }
    }
  });
});
