/**
 * Server configuration: environment variables with sane defaults,
 * persisted state lives under DATA_DIR.
 */
import path from 'node:path';

export interface ServerConfig {
    host: string;
    port: number;
    dataDirectory: string;
    dashboardDirectory: string;
    /** When set, an import job (scan+match+sync) runs automatically at startup. */
    importPath?: string;
    /** 'auto' (default) | 'all' | 'none' — which match tiers are confirmed without user review. */
    importAutoConfirm: 'auto' | 'all' | 'none';
    /** IMPORT_AUTO_DOWNLOAD=1: imported entries auto-download future new chapters. */
    importAutoDownload: boolean;
}

export function loadConfig(): ServerConfig {
    const dataDirectory = path.resolve(process.env.DATA_DIR || process.env.HAKUNEKO_DATA || './data');
    const autoConfirm = process.env.IMPORT_AUTO_CONFIRM || 'auto';
    return {
        host: process.env.HOST || '0.0.0.0',
        port: Number(process.env.PORT || 8080),
        dataDirectory,
        dashboardDirectory: path.resolve(import.meta.dirname, '../../dashboard/dist'),
        importPath: process.env.IMPORT_PATH || undefined,
        importAutoConfirm: (autoConfirm === 'all' || autoConfirm === 'none' ? autoConfirm : 'auto'),
        importAutoDownload: process.env.IMPORT_AUTO_DOWNLOAD === '1'
    };
}
