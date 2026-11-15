import multer from 'multer';
import { AppError } from '../../utils/errors.js';

const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
const maxUploadBytes = 10 * 1024 * 1024; // 10 MB per file

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadBytes, files: 200 },
  fileFilter: (_req, file, callback) => {
    if (!allowedMimeTypes.includes(file.mimetype)) {
      return callback(new AppError(400, 'UNSUPPORTED_IMAGE', `Unsupported file: ${file.originalname}`));
    }
    callback(null, true);
  },
});

// Accepts up to 200 files in a single "images" field.
export const parseBulkUpload = upload.array('images', 200);
