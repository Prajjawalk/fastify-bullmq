import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    cookies: Record<string, string>;
  }

  interface FastifyReply {
    sse: {
      send: (data: {
        id?: string;
        event?: string;
        data: unknown;
        retry?: number;
      }) => Promise<void>;
      keepAlive: () => void;
      onClose: (callback: () => void) => void;
    };
  }

  interface RouteShorthandOptions {
    sse?: boolean;
  }
}
