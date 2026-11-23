export const SESSION_ID_LENGTH = 16;

export const SESSION_PATH_PATTERN = new RegExp(`^/s/[0-9a-f]{${SESSION_ID_LENGTH}}(?=/|$)`);
