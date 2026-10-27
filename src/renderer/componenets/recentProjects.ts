const RECENT_KEY = 'sdstudio-recent-projects';
const RECENT_MAX = 5;

export function getRecentProjects(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.filter((entry): entry is string => typeof entry === 'string'),
      ),
    ].slice(0, RECENT_MAX);
  } catch {
    // Recent-project history is an optional view preference, not project data.
    return [];
  }
}

export function pushRecentProject(name: string) {
  const names = getRecentProjects().filter((entry) => entry !== name);
  names.unshift(name);
  try {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify(names.slice(0, RECENT_MAX)),
    );
  } catch {
    // An unavailable preferences store must not prevent opening a project.
  }
}
