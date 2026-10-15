"use strict";
/* Vercel function entry: every dynamic route in vercel.json (pages, /admin, /api/*, content.js, uploads) lands here. */
var createHandler = require("./_core").createHandler;
var handler = null;
module.exports = function(req, res){
  if(!handler) handler = createHandler(require("./_blob-store")());
  return handler(req, res);
};
