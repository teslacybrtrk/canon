import type { Env } from "./env";

/**
 * One referee per project. REFEREE_EPOCH is part of its name, so bumping the epoch
 * gives every project a fresh, empty referee (used to reset after rehearsals).
 */
export function refereeForProject(env: Env, project: string) {
  return env.REFEREE.get(env.REFEREE.idFromName(`${project}#${env.REFEREE_EPOCH}`));
}

/** Attempt repos are named "<project>-<suffix>". */
export function refereeForRepo(env: Env, repo: string) {
  return refereeForProject(env, repo.slice(0, repo.lastIndexOf("-")));
}
