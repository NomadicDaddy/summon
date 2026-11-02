// Test fixture: holds a FILE_READ_ATTRIBUTES-only handle (full sharing) on argv[2] until killed.
import { dlopen, FFIType, ptr } from 'bun:ffi';

const k = dlopen('kernel32.dll', {
	CreateFileW: {
		args: [
			FFIType.ptr,
			FFIType.u32,
			FFIType.u32,
			FFIType.ptr,
			FFIType.u32,
			FFIType.u32,
			FFIType.ptr,
		],
		returns: FFIType.i64,
	},
}).symbols;
const path = process.argv[2] ?? '';
const name = Buffer.from(`\\\\?\\${path}\0`, 'utf16le');
const handle = k.CreateFileW(ptr(name), 0x80, 0x7, null, 3, 0x0220_0000, null);
console.log(handle === -1n ? 'failed' : 'ready');
await Bun.sleep(20_000);
