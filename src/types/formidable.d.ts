declare module "formidable" {
  import type { IncomingMessage } from "node:http";

  export type Fields = Record<string, string | string[] | undefined>;

  export type File = {
    filepath: string;
    originalFilename: string | null;
    mimetype: string | null;
    size: number;
  };

  export type Files = Record<string, File | File[] | undefined>;

  export type FormidableOptions = {
    uploadDir?: string;
    maxFileSize?: number;
    maxTotalFileSize?: number;
    allowEmptyFiles?: boolean;
    multiples?: boolean;
    filter?: (part: {
      name: string;
      originalFilename: string | null;
      mimetype: string | null;
    }) => boolean;
  };

  export type FormidableInstance = {
    parse(
      req: IncomingMessage,
      callback: (
        error: Error | null,
        fields: Fields,
        files: Files,
      ) => void,
    ): void;
  };

  export default function formidable(options?: FormidableOptions): FormidableInstance;
}
