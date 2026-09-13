const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: 'evvcifss',
  api_key: '462634612381656',
  api_secret: 'CAzNS7jcTg4mdnemrESgm-hBh80'
});

cloudinary.api.resources({ type: 'upload', prefix: 'bhurakshak_documents', max_results: 30 })
  .then(result => {
    console.log(`Found ${result.resources.length} file(s) in bhurakshak_documents folder:`);
    result.resources.forEach(r => {
      console.log(`- ${r.public_id} (${r.format}, ${(r.bytes/1024).toFixed(1)} KB) -> ${r.secure_url}`);
    });
  })
  .catch(err => {
    console.error('ERROR checking Cloudinary:', err.message);
  });
