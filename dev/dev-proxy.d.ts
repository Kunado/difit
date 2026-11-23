export function originForApiServer(request: {
  origin: string | undefined;
  host: string | undefined;
  target: string;
}): string | undefined;
