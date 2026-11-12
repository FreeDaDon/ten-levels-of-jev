export declare const agentModel: () => string;
export declare function agentEnv(
  paths: { dir: string; cwd: string; eventLog: string },
  config: object,
  broker?: { url?: string; token?: string },
): Record<string, string>;
export declare function splitTools(tools: string[]): { builtIn: string[]; allow: string[]; mcp: string[] };
export declare function secretPaths(home?: string): string[];
export declare function guardSettings(
  mode?: string,
  secrets?: string[],
  available?: boolean,
): { settings: Record<string, any>; sandboxed: boolean; warning: string | null };
export declare const sandboxAvailable: () => boolean;
export declare const MAX_SESSIONS: number;
export declare const getByToken: (token: string) => any;
export declare const count: () => number;
export declare function cleanStale(): void;
export declare function start(opts: object): any;
export declare function getSession(id: string): any;
