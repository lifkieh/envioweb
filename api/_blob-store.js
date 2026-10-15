"use strict";
/* Storage adapter backed by Vercel Blob (private store). Reads bypass the CDN cache so a publish is
 * visible to every function instance right away. Needs BLOB_READ_WRITE_TOKEN (set by connecting the store). */
var blob = require("@vercel/blob");

function toBuffer(stream){ return new Response(stream).arrayBuffer().then(function(ab){ return Buffer.from(ab); }); }

module.exports = function createBlobStore(){
  var priv = { access: "private" };
  return {
    getText: function(key){
      return blob.get(key, { access: "private", useCache: false }).then(function(r){ return r && r.stream ? toBuffer(r.stream).then(function(b){ return b.toString("utf8"); }) : null; });
    },
    getBuffer: function(key){
      return blob.get(key, { access: "private", useCache: false }).then(function(r){ return r && r.stream ? toBuffer(r.stream).then(function(b){ return { buffer: b, contentType: (r.blob && r.blob.contentType) || "" }; }) : null; });
    },
    putText: function(key, text, contentType){
      return blob.put(key, text, { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: contentType || "text/plain; charset=utf-8" });
    },
    putBuffer: function(key, buf, contentType){
      return blob.put(key, buf, { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: contentType || "application/octet-stream" });
    },
    list: function(prefix){
      var out = [];
      function page(cursor){
        return blob.list({ prefix: prefix, cursor: cursor, limit: 1000 }).then(function(r){
          r.blobs.forEach(function(b){ out.push({ key: b.pathname, size: b.size, uploadedAt: b.uploadedAt }); });
          return r.hasMore && r.cursor ? page(r.cursor) : out;
        });
      }
      return page(undefined);
    },
    del: function(keys){ return keys.length ? blob.del(keys) : Promise.resolve(); }
  };
};
