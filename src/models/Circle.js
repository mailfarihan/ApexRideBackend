const mongoose = require('mongoose');

const memberSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  joinedAt: { type: Date, default: Date.now },
  role: { type: String, enum: ['owner', 'member'], default: 'member' }
}, { _id: false });

const inviteSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  invitedAt: { type: Date, default: Date.now },
  invitedBy: { type: String, default: null }
}, { _id: false });

const circleSchema = new mongoose.Schema({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true, maxlength: 60 },
  description: { type: String, maxlength: 240, default: '' },
  members: { type: [memberSchema], default: [] },
  pendingInvites: { type: [inviteSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

circleSchema.index({ 'members.userId': 1 });
circleSchema.index({ 'pendingInvites.userId': 1 });

circleSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Circle', circleSchema);
