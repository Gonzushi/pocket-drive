export interface FileItem { id: string; name: string; size: number; mime_type: string; kind: string; checksum: string; created_at: string; folder_id: string | null; location?: string }
export interface FolderItem { id: string; name: string; parent_id: string | null; created_at: string; item_count: number; location?: string }
export interface FolderDetails { id: string; name: string; file_count: number; folder_count: number; size: number }
export interface TreeFolder { id: string; name: string; parent_id: string | null }
export interface DriveItem { id: string; name: string; type: 'file' | 'folder' }
export interface StorageInfo { used_bytes: number; quota_bytes: number; available_bytes: number; reserved_bytes: number; file_count: number; disk_free_bytes: number; min_free_disk_bytes: number; max_file_bytes: number }
export interface ApiKey { id: string; name: string; scopes: string[]; created_at: string; last_used_at: string | null }
