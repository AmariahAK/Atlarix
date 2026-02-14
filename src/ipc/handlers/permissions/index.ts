/**
 * Permission System
 * =================
 * Export all permission-related modules
 */

export { PermissionInterceptor } from "./interceptor";
export * from "./handlers";
export type {
    PermissionRequest,
    PermissionResult,
    FileOperationPreview,
    CommandOperationPreview,
} from "@/lib/tools/permissions/schema";
export {
    createFilePermissionRequest,
    createBatchPermissionRequest,
    createCommandPermissionRequest,
    parsePermissionRequest,
    isPermissionRequest,
} from "@/lib/tools/permissions/schema";
