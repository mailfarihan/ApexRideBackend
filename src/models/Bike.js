const mongoose = require('mongoose');

const bikeSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  make: { type: String, required: true, trim: true },
  model: { type: String, required: true, trim: true },
  year: { type: Number, default: null },
  displacement: { type: Number, default: null }, // cc
  nickname: { type: String, default: '', trim: true, maxlength: 80 },
  photoUrl: { type: String, default: '' },
  isPrimary: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

// At most one primary per user (partial index)
bikeSchema.index(
  { userId: 1, isPrimary: 1 },
  { unique: true, partialFilterExpression: { isPrimary: true } }
);

module.exports = mongoose.model('Bike', bikeSchema);
