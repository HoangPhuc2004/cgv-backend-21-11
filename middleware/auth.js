const jwt = require('jsonwebtoken');

module.exports = function(req, res, next) {
    // Lấy token từ header
    const tokenHeader = req.header('Authorization');

    // Nếu không có token, user là khách (guest). Vẫn cho qua.
    if (!tokenHeader) {
        req.user = null; // Đặt req.user là null
        return next();
    }

    try {
        // Token có dạng "Bearer [token]", ta tách nó ra
        const tokenOnly = tokenHeader.split(' ')[1];
        
        if (!tokenOnly) {
            req.user = null; // Token header có nhưng không hợp lệ
            return next();
        }

        const decoded = jwt.verify(tokenOnly, process.env.JWT_SECRET);
        
        // Gán thông tin user đã giải mã
        req.user = decoded.user;
        next(); // Chuyển sang bước tiếp theo
    } catch (err) {
        // Token sai hoặc hết hạn, coi như là khách
        req.user = null;
        next();
    }
};