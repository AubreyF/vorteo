import { z } from "zod";

export const ProjectDirectoryBrowseRequestSchema = z.object({
  type: z.literal("project.directory.browse.request"),
  rootId: z.string().optional(),
  path: z.string().optional(),
  hostPath: z.string().optional(),
  showHidden: z.boolean().optional(),
  offset: z.number().int().min(0).optional(),
  requestId: z.string(),
});

export const ProjectDirectoryBrowseResponseSchema = z.object({
  type: z.literal("project.directory.browse.response"),
  payload: z.object({
    roots: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        containerPath: z.string(),
        hostPath: z.string().nullable(),
      }),
    ),
    directory: z
      .object({
        rootId: z.string(),
        path: z.string(),
        parent: z.string().nullable(),
        containerPath: z.string(),
        hostPath: z.string().nullable(),
        entries: z.array(
          z.object({
            name: z.string(),
            path: z.string(),
            // COMPAT(projectsRoot): added 2026-10-22; only Projects folder listings mark these.
            git: z.boolean().optional(),
            projectId: z.string().optional(),
          }),
        ),
        nextOffset: z.number().int().nullable(),
      })
      .nullable(),
    error: z.string().nullable(),
    errorCode: z.string().nullable(),
    requestId: z.string(),
  }),
});

export type ProjectDirectoryBrowseRequest = z.infer<typeof ProjectDirectoryBrowseRequestSchema>;
export type ProjectDirectoryBrowsePayload = z.infer<
  typeof ProjectDirectoryBrowseResponseSchema
>["payload"];
