const multer = require('multer');
const {CloudinaryStorage} = require('multer-storage-cloudinary')
const cloudinary = require('./coudinaryconfig')

const storage = new CloudinaryStorage({
    cloudinary:cloudinary,
    params:{
        folder:"BackEnd-Test",
        allowedFormats:["jpg","jpeg","png","webp","heic"]
    }
})

const upload = multer({storage:storage})


module.exports = upload;