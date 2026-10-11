const express = require("express");
const Coupon = require("../controller/CouponController");
const router = express.Router();


const { authenticateAdmin } = require("../middleware/AdminAuthMiddleware");

// Read — any authenticated admin
router.get("/coupons",  Coupon.getAllCoupons);
router.get("/coupons/:id",  Coupon.getCouponById);

// Create and update — authenticated admin
router.post("/coupons", authenticateAdmin, Coupon.createCoupon);
router.put("/coupons/:id", authenticateAdmin, Coupon.updateCoupon);

// Delete — requires the Checkout Rules module permission
router.delete("/coupons/:id", authenticateAdmin, Coupon.deleteCoupon);

module.exports = router;
