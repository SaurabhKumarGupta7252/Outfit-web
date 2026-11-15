import multer from 'multer';
import { AppError } from '../../utils/errors.js';

export const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
export const maxUploadBytes = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadBytes, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!allowedMimeTypes.includes(file.mimetype)) {
      return callback(new AppError(400, 'UNSUPPORTED_IMAGE', 'Only JPEG, PNG or WebP images are allowed.'));
    }
    callback(null, true);
  },
});

export const parseImageUpload = upload.single('image');
