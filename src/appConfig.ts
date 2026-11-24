import { invoke } from '@tauri-apps/api/core';

const APP_CONFIG_URL = 'https://www.mahes.app/api/v1/apps/cvr/app-config';
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface RemoteDesktopAppConfig {
  app: {
    isLocked: boolean;
    lockTitle: string;
    lockMessage: string;
    lockUntil: string | null;
  };
  update: {
    latestVersion: string;
    minimumVersion: string;
    updateRequired: boolean;
    title: string;
    message: string;
    downloadUrl: string | null;
    releaseNotes: string[];
  };
  maintenance: {
    enabled: boolean;
    message: string | null;
    startAt: string | null;
    endAt: string | null;
  };
}

export type DesktopAppAccessPolicy =
  | { status: 'allowed'; config: RemoteDesktopAppConfig }
  | { status: 'locked'; title: string; message: string; lockUntil: string | null }
  | { status: 'maintenance'; title: string; message: string; endAt: string | null }
  | {
      status: 'update_required';
      title: string;
      message: string;
      latestVersion: string;
      minimumVersion: string;
      downloadUrl: string | null;
      releaseNotes: string[];
    };

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function cleanText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function compareSemver(a: string, b: string): number {
  const parse = (version: string) =>
    version
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]!
      .split('.')
      .map(part => {
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const partsA = parse(a);
  const partsB = parse(b);
  const len = Math.max(partsA.length, partsB.length, 3);
  for (let i = 0; i < len; i += 1) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function isVersionLessThan(installedVersion: string, targetVersion: string): boolean {
  if (!targetVersion.trim()) return false;
  return compareSemver(installedVersion, targetVersion) < 0;
}

export async function fetchDesktopAppConfig(): Promise<RemoteDesktopAppConfig> {
  const fetchDirect = async () => {
    const urls = [
      `/api/v1/apps/cvr/app-config?t=${Date.now()}`,
      `${APP_CONFIG_URL}?t=${Date.now()}`,
    ];
    let lastError: unknown;
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) continue;
        const json = (await response.json()) as unknown;
        if (json && typeof json === 'object' && 'success' in json) {
          return json;
        }
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Gagal mengambil App Config.');
  };

  const isDevServer =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  let raw: unknown;
  if (isTauri && !isDevServer) {
    try {
      raw = await invoke('get_app_config');
    } catch {
      raw = await fetchDirect();
    }
  } else {
    try {
      raw = await fetchDirect();
    } catch {
      if (isTauri) {
        raw = await invoke('get_app_config');
      } else {
        throw new Error('Gagal mengambil App Config.');
      }
    }
  }

  if (
    !raw ||
    typeof raw !== 'object' ||
    !('success' in raw) ||
    raw.success !== true ||
    !('data' in raw) ||
    !raw.data ||
    typeof raw.data !== 'object'
  ) {
    throw new Error('Format respons App Config tidak valid.');
  }

  const data = raw.data as Record<string, unknown>;
  const app = (data.app && typeof data.app === 'object' ? data.app : {}) as Record<string, unknown>;
  const update = (data.update && typeof data.update === 'object' ? data.update : {}) as Record<string, unknown>;
  const maintenance = (
    data.maintenance && typeof data.maintenance === 'object' ? data.maintenance : {}
  ) as Record<string, unknown>;

  const releaseNotes = Array.isArray(update.release_notes)
    ? update.release_notes
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map(item => item.trim())
    : [];

  return {
    app: {
      isLocked: Boolean(app.is_locked),
      lockTitle: cleanText(app.lock_title, 'Aplikasi Sedang Dinonaktifkan'),
      lockMessage: cleanText(app.lock_message, 'Silakan hubungi administrator Mahesapp.'),
      lockUntil: typeof app.lock_until === 'string' && app.lock_until.trim() ? app.lock_until.trim() : null,
    },
    update: {
      latestVersion: cleanText(update.latest_version, '0.1.0'),
      minimumVersion: cleanText(update.minimum_version, '0.1.0'),
      updateRequired: Boolean(update.update_required),
      title: cleanText(update.title, 'Update Canvas Vector Recorder Tersedia'),
      message: cleanText(update.message, 'Versi terbaru berisi perbaikan dan peningkatan performa.'),
      downloadUrl: safeHttpsUrl(update.download_url),
      releaseNotes,
    },
    maintenance: {
      enabled: Boolean(maintenance.enabled),
      message: typeof maintenance.message === 'string' && maintenance.message.trim() ? maintenance.message.trim() : null,
      startAt: typeof maintenance.start_at === 'string' && maintenance.start_at.trim() ? maintenance.start_at.trim() : null,
      endAt: typeof maintenance.end_at === 'string' && maintenance.end_at.trim() ? maintenance.end_at.trim() : null,
    },
  };
}

export function evaluateDesktopAppConfig(
  config: RemoteDesktopAppConfig,
  installedVersion: string,
): DesktopAppAccessPolicy {
  if (config.app.isLocked) {
    return {
      status: 'locked',
      title: config.app.lockTitle,
      message: config.app.lockMessage,
      lockUntil: config.app.lockUntil,
    };
  }

  const belowMinimum = isVersionLessThan(installedVersion, config.update.minimumVersion);
  const belowLatestWhenRequired =
    config.update.updateRequired && isVersionLessThan(installedVersion, config.update.latestVersion);

  if (belowMinimum || belowLatestWhenRequired) {
    return {
      status: 'update_required',
      title: config.update.title || 'Update Wajib Diperlukan',
      message: config.update.message,
      latestVersion: config.update.latestVersion,
      minimumVersion: config.update.minimumVersion,
      downloadUrl: config.update.downloadUrl,
      releaseNotes: config.update.releaseNotes,
    };
  }

  if (config.maintenance.enabled) {
    return {
      status: 'maintenance',
      title: 'Sedang Dalam Pemeliharaan',
      message:
        config.maintenance.message ??
        'Layanan Canvas Vector Recorder sedang menjalani pemeliharaan terjadwal. Silakan coba beberapa saat lagi.',
      endAt: config.maintenance.endAt,
    };
  }

  return {
    status: 'allowed',
    config,
  };
}
