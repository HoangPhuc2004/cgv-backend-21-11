// Import các thư viện cần thiết
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const authMiddleware = require('./middleware/auth');
const Groq = require('groq-sdk');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 5001;

// ... middleware setup ...
app.use(cors());
app.use(express.json());

// ... database pool setup ...
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// === KHAI BÁO GROQ VÀ CÁC HÀM TRUY VẤN CSDL (DATABASE FUNCTIONS) ===

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// (ĐÃ NÂNG CẤP) Hàm getQueryDate mạnh mẽ hơn
function getQueryDate(dateString) {
    
    // Helper to get "today" in Vietnam (UTC+7)
    // Trả về chuỗi YYYY-MM-DD
    const getTodayInVietnam = () => {
        const now = new Date();
        // Chuyển 'now' sang múi giờ VN (UTC+7)
        const vnTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
        vnTime.setHours(0, 0, 0, 0);

        const year = vnTime.getFullYear();
        const month = String(vnTime.getMonth() + 1).padStart(2, '0'); // getMonth() là 0-11
        const day = String(vnTime.getDate()).padStart(2, '0');
        
        return `${year}-${month}-${day}`;
    };
    
    // Helper to get "tomorrow" in Vietnam
    const getTomorrowInVietnam = () => {
        const now = new Date();
        const vnTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
        vnTime.setDate(vnTime.getDate() + 1); // Lấy ngày mai
        vnTime.setHours(0, 0, 0, 0);

        const year = vnTime.getFullYear();
        const month = String(vnTime.getMonth() + 1).padStart(2, '0');
        const day = String(vnTime.getDate()).padStart(2, '0');
        
        return `${year}-${month}-${day}`;
    };

    const todayVNDateString = getTodayInVietnam();
    // Tạo ngày 'today' (đã set 0 giờ) ở múi giờ VN
    const todayVN = new Date(new Date(todayVNDateString).toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
    todayVN.setHours(0, 0, 0, 0);


    if (!dateString) {
        // Mặc định là hôm nay (VN) nếu không có chuỗi ngày
        return todayVNDateString;
    }

    const lowerCase = dateString.toLowerCase().trim();
    
    if (lowerCase.includes('hôm nay') || lowerCase.includes('today')) {
        return todayVNDateString;
    }
    if (lowerCase.includes('ngày mai') || lowerCase.includes('tomorrow')) {
        return getTomorrowInVietnam();
    }

    // === SỬA LỖI REGEX ===
    // Thử match YYYY-MM-DD trước (ví dụ: "ngày 2025-11-15")
    let match = lowerCase.match(/(\d{4})[\-\/\.](\d{1,2})[\-\/\.](\d{1,2})/);
    if (match) {
        const year = parseInt(match[1], 10);
        const month = parseInt(match[2], 10) - 1; // JS month is 0-indexed
        const day = parseInt(match[3], 10);
        // Tạo ngày bằng cách sử dụng các thành phần (an toàn với múi giờ)
        const queryDate = new Date(year, month, day); 
        queryDate.setHours(0, 0, 0, 0);
        return queryDate.toISOString().split('T')[0];
    }

    // Thử match DD/MM/YYYY hoặc DD-MM-YYYY (và các biến thể)
    // Regex này tìm DD và MM, và (tùy chọn) YYYY
    // (?:\D*?) non-greedy-ly matches optional non-digits at the start
    match = lowerCase.match(/(?:\D*?)(\d{1,2})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{4}))?\D*/);
    if (match) {
        const day = parseInt(match[1], 10);
        const month = parseInt(match[2], 10) - 1; // JS month is 0-indexed
        const year = match[3] ? parseInt(match[3], 10) : todayVN.getFullYear(); // Default to current VN year
        
        const queryDate = new Date(year, month, day); 
        queryDate.setHours(0, 0, 0, 0);

        // Xử lý trường hợp người dùng nhập "15-11" nhưng năm nay đã qua tháng 11
        if (queryDate < todayVN) {
             queryDate.setFullYear(year + 1);
        }

        return queryDate.toISOString().split('T')[0];
    }
    // === KẾT THÚC SỬA LỖI REGEX ===

    // Mặc định là hôm nay nếu không parse được
    console.warn(`[getQueryDate] Không thể parse chuỗi ngày: "${dateString}". Trả về ngày hôm nay (VN).`);
    return todayVNDateString;
}


/**
 * CÔNG CỤ TRUY VẤN 1: Lấy suất chiếu cho một phim cụ thể
 * (Phiên bản nâng cấp: Chấp nhận city_name hoặc cinema_name)
 */
async function get_showtimes_for_movie(args) {
    // args là một object: { movie_title, date, city_name?, cinema_name? }
    const { movie_title, city_name, cinema_name, date } = args;
    console.log(`[Agent] Đang chạy tool: get_showtimes_for_movie`, args);
    
    // === LOGIC KIỂM TRA ĐẦU VÀO MỚI ===
    const queryDate = getQueryDate(date); // 'date' có thể undefined, hàm này xử lý được

    // 1. Phải có địa điểm (hoặc rạp hoặc thành phố)
    if (!city_name && !cinema_name) {
         return JSON.stringify({ message: `Bạn muốn xem phim ở thành phố hay rạp nào?` });
    }
    
    // 2. Phải có phim
    if (!movie_title) {
        let location = cinema_name ? `tại ${cinema_name}` : `tại ${city_name}`;
        // Trả về một tin nhắn (message) thay vì lỗi (error)
        return JSON.stringify({ message: `OK, tôi sẽ tra cứu ${location}. Bạn muốn xem phim gì?` });
    }
    // === KẾT THÚC LOGIC MỚI ===

    // 3. Đã đủ thông tin -> Truy vấn DB
    try {
        let queryParams = [`%${movie_title}%`, queryDate];
        let query = `
            SELECT 
                s.showtime_id,
                s.start_time, 
                s.ticket_price,
                c.name as cinema_name,
                c.city,
                m.movie_id,
                m.title,
                m.features
            FROM showtimes s
            JOIN movies m ON s.movie_id = m.movie_id
            JOIN cinemas c ON s.cinema_id = c.cinema_id
            WHERE 
                m.title ILIKE $1 
                AND s.start_time::date = $2
                AND s.start_time > NOW()
        `;

        // Xây dựng query động
        if (city_name) {
            queryParams.push(`%${city_name}%`);
            query += ` AND c.city ILIKE $${queryParams.length}`;
        }
        
        if (cinema_name) {
            queryParams.push(`%${cinema_name}%`);
            query += ` AND c.name ILIKE $${queryParams.length}`;
        }

        query += ` ORDER BY c.name, s.start_time;`;
        
        console.log("[Agent] SQL Query:", query);
        console.log("[Agent] SQL Params:", queryParams);

        const result = await pool.query(query, queryParams);
        
        if (result.rows.length === 0) {
            let errorMessage = `Rất tiếc, tôi không tìm thấy suất chiếu nào cho phim '${movie_title}'`;
            if (cinema_name) errorMessage += ` tại '${cinema_name}'`;
            else if (city_name) errorMessage += ` tại '${city_name}'`;
            errorMessage += ` vào ngày ${queryDate}.`;
            return JSON.stringify({ message: errorMessage });
        }
        
        // Trả về dữ liệu đầy đủ
        return JSON.stringify(result.rows);

    } catch (e) {
        console.error("Lỗi khi truy vấn get_showtimes_for_movie:", e);
        return JSON.stringify({ error: "Đã xảy ra lỗi khi truy vấn cơ sở dữ liệu." });
    }
}

/**
 * CÔNG CỤ TRUY VẤN 2: Lấy danh sách phim đang chiếu tại một rạp cụ thể
 */
async function get_movies_at_cinema(cinema_name, date) {
    console.log(`[Agent] Đang chạy tool: get_movies_at_cinema`, { cinema_name, date });
    const queryDate = getQueryDate(date);

    try {
        const query = `
            SELECT 
                m.title, 
                m.genre,
                COUNT(s.showtime_id) as showtime_count
            FROM showtimes s
            JOIN movies m ON s.movie_id = m.movie_id
            JOIN cinemas c ON s.cinema_id = c.cinema_id
            WHERE 
                c.name ILIKE $1 
                AND s.start_time::date = $2
                AND s.start_time > NOW()
            GROUP BY m.title, m.genre
            ORDER BY m.title;
        `;
        const result = await pool.query(query, [`%${cinema_name}%`, queryDate]);

        if (result.rows.length === 0) {
            return JSON.stringify({ message: `Không tìm thấy phim nào đang chiếu tại '${cinema_name}' vào ngày ${queryDate}.` });
        }
        return JSON.stringify(result.rows);
    } catch (e) {
        console.error("Lỗi khi truy vấn get_movies_at_cinema:", e);
        return JSON.stringify({ error: "Đã xảy ra lỗi khi truy vấn cơ sở dữ liệu." });
    }
}

/**
 * CÔNG CỤ TRUY VẤN 3: Lấy thông tin chi tiết (cốt truyện, diễn viên) của một phim
 */
async function get_movie_details(movie_title) {
    console.log(`[Agent] Đang chạy tool: get_movie_details`, { movie_title });
    try {
        const query = `
            SELECT 
                title, description, genre, rating, director, cast_members, duration_minutes 
            FROM movies 
            WHERE title ILIKE $1 
            LIMIT 1;
        `;
        const result = await pool.query(query, [`%${movie_title}%`]);
        
        if (result.rows.length === 0) {
            return JSON.stringify({ message: `Không tìm thấy thông tin cho phim '${movie_title}'.` });
        }
        return JSON.stringify(result.rows[0]);
    } catch (e) {
        console.error("Lỗi khi truy vấn get_movie_details:", e);
        return JSON.stringify({ error: "Đã xảy ra lỗi khi truy vấn cơ sở dữ liệu." });
    }
}

/**
 * CÔNG CỤ TRUY VẤN 4: Đề xuất phim (MÔ HÌNH HYBRID)
 * (Sử dụng userId từ authMiddleware, gọi đến Python API)
 */
async function get_movie_recommendations_based_on_history(userId) {
    console.log(`[Agent] Đang chạy tool (HYBRID): get_movie_recommendations_based_on_history cho UserID: ${userId}`);
    
    if (!userId) {
        return JSON.stringify({ error: "Không xác định được người dùng." });
    }

    try {
        // Định nghĩa URL của API Python (FastAPI)
        const pythonApiUrl = `http://localhost:8000/recommendations/${userId}`;
        
        console.log(`[Agent] Đang gọi Python API tại: ${pythonApiUrl}`);
        
        // Dùng axios để gọi API Python
        const response = await axios.get(pythonApiUrl);
        
        // Kiểm tra nếu API Python trả về lỗi (ví dụ: user không có lịch sử)
        if (response.data.message || response.data.error) {
            console.log("[Agent] Python API trả về một tin nhắn (ví dụ: không có dữ liệu):", response.data);
            return JSON.stringify(response.data);
        }

        console.log(`[Agent] Python API trả về ${response.data.length} đề xuất.`);
        
        // Trả về kết quả (dưới dạng chuỗi JSON) cho LLM
        return JSON.stringify(response.data);

    } catch (e) {
        console.error("Lỗi khi gọi Python API (get_movie_recommendations_based_on_history):", e.message);
        // Trả về một lỗi thân thiện cho LLM
        return JSON.stringify({ error: "Đã xảy ra lỗi khi cố gắng tạo đề xuất phim cho bạn." });
    }
}


// "Menu" các công cụ mà LLM có thể gọi
const tools = [
    {
        type: "function",
        function: {
            name: "get_showtimes_for_movie",
            description: "Lấy suất chiếu cho một BỘ PHIM, lọc theo NGÀY và (THÀNH PHỐ hoặc RẠP PHIM CỤ THỂ).",
            parameters: {
                type: "object",
                properties: {
                    movie_title: { type: "string", description: "Tên bộ phim, ví dụ: 'Mai'" },
                    date: { type: "string", description: "Ngày cần tra cứu, ví dụ: 'hôm nay', 'ngày mai', '15-11'. Nếu không có, mặc định là 'hôm nay'." },
                    city_name: { type: "string", description: "Tên thành phố (nếu người dùng cung cấp). Ví dụ: 'Đà Nẵng'" },
                    cinema_name: { type: "string", description: "Tên rạp phim cụ thể (nếu người dùng cung cấp). Ví dụ: 'CGV Lotte Mart Đà Nẵng'" }
                },
                // === Đã gỡ bỏ 'required' để AI linh hoạt hơn ===
                // required: ["movie_title", "date"] 
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_movies_at_cinema",
            description: "Lấy danh sách các BỘ PHIM đang được chiếu tại một RẠP PHIM cụ thể vào một NGÀY cụ thể.",
            parameters: {
                type: "object",
                properties: {
                    cinema_name: { type: "string", description: "Tên rạp phim, ví dụ: 'CGV Giga Mall', 'CGV Vincom Center'" },
                    date: { type: "string", description: "Ngày cần tra cứu, ví dụ: 'hôm nay', 'ngày mai'" }
                },
                required: ["cinema_name", "date"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_movie_details",
            description: "Lấy thông tin chi tiết (cốt truyện, diễn viên, đạo diễn, thể loại) của một BỘ PHIM cụ thể.",
            parameters: {
                type: "object",
                properties: {
                    movie_title: { type: "string", description: "Tên bộ phim, ví dụ: 'Mai'" }
                },
                required: ["movie_title"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_movie_recommendations_based_on_history",
            description: "Đề xuất 5 phim (sử dụng mô hình AI hybrid) dựa trên lịch sử xem phim, sở thích thể loại, và hành vi của người dùng tương tự. Chỉ gọi khi user hỏi chung chung như 'đề xuất phim', 'phim nào hay', 'nên xem gì'. Không cần tham số đầu vào từ user.",
            parameters: {
                type: "object",
                properties: {},
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "search_cgv_policies",
            description: "Tra cứu thông tin về: Quy định chung (regulations) và Chính sách thanh toán (payment policy) của CGV. Dùng khi user hỏi về: quy định rạp, mang đồ ăn, hoàn vé, phương thức thanh toán, lỗi trừ tiền, vé trẻ em, thú cưng...",
            parameters: {
                type: "object",
                properties: {
                    query: { 
                        type: "string", 
                        description: "Câu hỏi hoặc từ khóa chính. Ví dụ: 'quy định mang thú cưng', 'chính sách hoàn tiền vé online'" 
                    }
                },
                required: ["query"]
            }
        }
    }
];

// === PROMPT MỚI ===

// Prompt 1: Dành cho tra cứu và chat thông thường (Giai đoạn 1 & 2)
// SỬA: Thêm quy tắc GHI NHỚ BỐI CẢNH
const getSystemPrompt_Normal = (user, availableMoviesList, availableCitiesList, availableCinemasList) => `
Bạn là "CGV-Bot", một trợ lý AI chuyên nghiệp và thân thiện của rạp phim CGV.
Bạn đang nói chuyện với ${user.username}.

**DỮ LIỆU HIỆN CÓ (RAG) - Chỉ dùng để đối chiếu tên:**
* Các phim đang chiếu: ${availableMoviesList}
* Các thành phố: ${availableCitiesList}
* Các rạp: ${availableCinemasList}

**QUY TẮC CỦA BẠN:**

**1. ƯU TIÊN TRA CỨU & ĐỀ XUẤT:**
* Khi người dùng hỏi thông tin (suất chiếu, chi tiết phim) hoặc hỏi đề xuất phim chung chung.
* Luôn cố gắng **tự động gọi tool** \`get_showtimes_for_movie\`, \`get_movies_at_cinema\`, \`get_movie_details\`, hoặc \`get_movie_recommendations_based_on_history\` bằng cách sử dụng schema tool đã cung cấp.
* **GHI NHỚ BỐI CẢNH (RẤT QUAN TRỌNG):** Khi người dùng cung cấp thông tin mới (ví dụ: "ngày 15-11"), bạn PHẢI NHỚ LẠI bối cảnh cũ (ví dụ: phim 'Wicked', rạp 'CGV Vincom Đà Nẵng') từ các tin nhắn trước đó và GỘP TẤT CẢ thông tin vào lệnh gọi tool.
* **VÍ DỤ GHI NHỚ:**
    * User: "cgv vincom đà nẵng"
    * Bot: (Sẽ gọi tool \`get_showtimes_for_movie\` với \`cinema_name: 'cgv vincom đà nẵng'\`)
    * Bot: (Tool trả về: "Bạn muốn xem phim gì?")
    * Bot: (Hỏi user: "OK, tôi sẽ tra cứu ở cgv vincom đà nẵng. Bạn muốn xem phim gì?")
    * User: "phim wicked"
    * Bot: (PHẢI gọi tool với \`cinema_name: 'cgv vincom đà nẵng'\`, \`movie_title: 'wicked'\`, \`date: 'hôm nay'\`)
* **TRÌNH BÀY KẾT QUẢ:** Sau khi tool chạy (và bạn nhận được \`role: "tool"\`), hãy tóm tắt kết quả JSON đó (nếu là danh sách suất chiếu) hoặc trả lời tin nhắn (nếu là câu hỏi) một cách thân thiện.
* **QUAN TRỌNG:** Khi liệt kê suất chiếu, HÃY BAO GỒM các định dạng phim (features) nếu có (ví dụ: "3D", "IMAX").
* **VÍ DỤ:** "Tôi tìm thấy 2 suất 'Wicked' tại CGV Vincom Đà Nẵng hôm nay: Suất 1: 10:00 (IMAX, 3D) - 100.000 đồng. Suất 2: 13:45 (IMAX, 3D) - 80.000 đồng. Bạn muốn chọn suất nào?"
* **XỬ LÝ ĐẶT VÉ (RẤT QUAN TRỌNG):** Nếu người dùng nói "tôi muốn đặt vé" (như ảnh 00.10.34.png), BẠN KHÔNG ĐƯỢC HỎI TÊN HAY SỐ ĐIỆN THOẠI. Thay vào đó, bạn PHẢI HỎI LẠI: "Bạn muốn xem phim gì, ở rạp nào và vào ngày nào?".

**2. CHAT BÌNH THƯỜNG:**
* Nếu không phải trường hợp trên, hãy trả lời như một trợ lý thân thiện.

**3. QUY TẮC VÀNG (CHỐNG ẢO GIÁC):**
* NẾU KẾT QUẢ TỪ TOOL LÀ RỖNG (ví dụ: \`[]\`) hoặc là một tin nhắn lỗi (ví dụ: \`{"message": "Không tìm thấy..."}\`), BẠN PHẢI BÁO LẠI CHÍNH XÁC LỖI ĐÓ CHO NGƯỜI DÙNG (ví dụ: "Rất tiếc, tôi không tìm thấy...").
* **TUYỆT ĐỐI CẤM (LỖI NGHIÊM TRỌNG):** BẠN KHÔNG BAO GIỜ được phép trả lời cho người dùng bằng một văn bản trông giống như code hoặc tên hàm (ví dụ: "function=get_showtimes_for_movie>"). Nếu bạn quyết định gọi một hàm, BẠN PHẢI sử dụng định dạng \`tool_calls\` JSON.
* **TUYỆT ĐỐI CẤM (LỖI ẢO GIÁC):** BẠN KHÔNG BAO GIỜ được phép tự bịa ra kết quả suất chiếu. Nếu người dùng yêu cầu tra suất chiếu, bạn PHẢI gọi tool \`get_showtimes_for_movie\`. Đừng trả lời "Tôi đã tìm thấy..." nếu bạn chưa gọi tool.
* **TUYỆT ĐỐI CẤM:** Bạn không phải là người chốt đơn. Nếu người dùng chọn một suất chiếu cụ thể (ví dụ: 'chọn suất 16:30'), nhiệm vụ của bạn *chỉ* là chuẩn bị gọi tool (nếu thiếu thông tin) hoặc gọi tool (nếu đủ thông tin). ĐỪNG BAO GIỜ tự trả lời 'Tôi đã gọi suất...'.
`;

// Prompt 2: Dành riêng cho việc chốt vé (Giai đoạn 3)
// SỬA: Thay đổi nhiệm vụ: Chỉ trích xuất SỐ THỨ TỰ hoặc GIỜ
const getSystemPrompt_ChotVe = () => `
Bạn là một bot trích xuất thông tin. Lịch sử chat chứa:
1. Một tin nhắn \`role: "assistant"\` liệt kê các suất chiếu (ví dụ: "Suất 1: 10:00", "Suất 2: 13:45").
2. Một tin nhắn \`role: "user"\` (cuối cùng) chỉ ra lựa chọn của họ (ví dụ: "suất 2", "cái 13:45").

**HÀNH ĐỘNG CỦA BẠN:**
Xác định xem người dùng đã chọn suất nào. Trả lời CHỈ bằng JSON.
- Nếu user chọn bằng SỐ THỨ TỰ (ví dụ: "suất 2", "cái thứ hai"), trả về: \`{"choice_index": 2}\` (số là 1-based index).
- Nếu user chọn bằng GIỜ (ví dụ: "suất 13:45", "1:45 chiều"), trả về: \`{"choice_time": "13:45"}\` (dạng HH:mm).
- Nếu user TỪ CHỐI (ví dụ: "không", "thôi"), trả về: \`{"choice_index": -1}\`.

**KHÔNG** được thêm bất kỳ lời nói nào. Chỉ trả về JSON.

**VÍ DỤ 1 (Chọn theo số):**
* User: "suất 2"
* Bot: \`{"choice_index": 2}\`

**VÍ DỤ 2 (Chọn theo giờ):**
* User: "cho tôi suất 10:00"
* Bot: \`{"choice_time": "10:00"}\`

**VÍ DỤ 3 (Từ chối):**
* User: "thôi không đặt nữa"
* Bot: \`{"choice_index": -1}\`
`;


// === API CHATBOT NÂNG CẤP (STATEFUL VỚI DATABASE) ===
app.post('/api/chat', authMiddleware, async (req, res) => {
    // BƯỚC 1: Lấy thông tin mới
    // Lịch sử (history) không còn được gửi từ client nếu đã đăng nhập
    const { message, conversation_id } = req.body; 
    const userId = req.user ? req.user.id : null; // userId là null nếu là khách
    let convId = conversation_id;
    let isNewConversation = false;

    if (!message) {
        return res.status(400).json({ message: 'Tin nhắn không được để trống.' });
    }

    const client = await pool.connect(); 
    try {
        await client.query('BEGIN'); // Bắt đầu transaction

        let conversationHistory = []; // Lịch sử chat (dạng Groq)

        if (userId) {
            // --- XỬ LÝ NGƯỜI DÙNG ĐÃ ĐĂNG NHẬP ---
            if (!convId) {
                // Nếu không có convId (chat mới), tạo một ID mới
                convId = `user_${userId}_${Date.now()}`;
                isNewConversation = true;
            } else {
                // Nếu có convId, kiểm tra xem có quá 6 tiếng không (Req 2)
                const lastMessageRes = await client.query(
                    `SELECT created_at FROM ChatHistory 
                     WHERE conversation_id = $1 
                     ORDER BY created_at DESC LIMIT 1`,
                    [convId]
                );

                if (lastMessageRes.rows.length > 0) {
                    const lastMessageTime = new Date(lastMessageRes.rows[0].created_at);
                    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
                    
                    if (lastMessageTime < sixHoursAgo) {
                        // Quá 6 tiếng, tạo session mới
                        convId = `user_${userId}_${Date.now()}`;
                        isNewConversation = true;
                    }
                } else {
                    // convId được gửi lên nhưng không có trong DB (lỗi lạ), tạo mới
                     convId = `user_${userId}_${Date.now()}`;
                     isNewConversation = true;
                }
            }

            // Lưu tin nhắn mới của người dùng
            await client.query(
                `INSERT INTO ChatHistory (conversation_id, user_id, sender, content)
                 VALUES ($1, $2, 'user', $3)`,
                [convId, userId, message]
            );

            // Lấy lịch sử (đã bao gồm tin nhắn mới) từ DB
            const historyResult = await client.query(
                `SELECT message_id, sender, content, metadata 
                 FROM ChatHistory 
                 WHERE conversation_id = $1 
                 ORDER BY created_at ASC 
                 LIMIT 15`, // Lấy 15 tin nhắn gần nhất
                [convId]
            );
            
            // Chuyển đổi lịch sử từ DB sang định dạng Groq
            conversationHistory = historyResult.rows.map(row => {
                if (row.sender === 'user') return { role: 'user', content: row.content };
                if (row.sender === 'assistant' && row.metadata?.tool_calls) {
                    return { role: 'assistant', content: row.content, tool_calls: row.metadata.tool_calls };
                }
                if (row.sender === 'assistant') return { role: 'assistant', content: row.content };
                if (row.sender === 'tool') {
                    return { role: 'tool', tool_call_id: row.metadata.tool_call_id, name: row.metadata.name, content: row.content };
                }
            }).filter(Boolean);

        } else {
            // --- XỬ LÝ KHÁCH (GUEST) (Req 3) ---
            // Khách sẽ gửi toàn bộ lịch sử (stateless)
            const history = req.body.history || [];
            conversationHistory = history.map(msg => ({
                role: msg.sender === 'user' ? 'user' : 'assistant',
                content: msg.text 
            }));
            // Thêm tin nhắn mới nhất
            conversationHistory.push({ role: 'user', content: message });
        }


        // --- Logic LLM (Giữ nguyên từ code cũ của bạn) ---
        
        // Lấy thông tin RAG (user, movies, cinemas...)
        const user = userId ? (await client.query('SELECT username, email FROM Users WHERE user_id = $1', [userId])).rows[0] : { username: 'Khách', email: '' };
        const moviesQuery = "SELECT title FROM Movies WHERE release_date <= CURRENT_DATE ORDER BY title";
        const moviesResult = await client.query(moviesQuery);
        const availableMoviesList = moviesResult.rows.map(m => m.title).join(', ');
        const citiesQuery = "SELECT DISTINCT city FROM Cinemas ORDER BY city";
        const citiesResult = await client.query(citiesQuery);
        const availableCitiesList = citiesResult.rows.map(c => c.city).join(', ');
        const cinemasQuery = "SELECT name, city FROM Cinemas ORDER BY city, name";
        const cinemasResult = await client.query(cinemasQuery);
        const availableCinemasList = cinemasResult.rows.map(c => c.name).join('; ');

        // Kiểm tra Giai Đoạn 3 (chốt đơn)
        let isChotDonGiaiDoan3 = false;
        if (conversationHistory.length > 0) { 
            const lastMessage_User = conversationHistory[conversationHistory.length - 1];
            const secondToLastMessage_Bot = conversationHistory.length > 1 ? conversationHistory[conversationHistory.length - 2] : null;

            if (lastMessage_User.role === 'user' && secondToLastMessage_Bot && secondToLastMessage_Bot.role === 'assistant') {
                const botQuestion = (secondToLastMessage_Bot.content || "").toLowerCase();
                if (botQuestion.includes("suất nào") || botQuestion.includes("chọn suất này không") || botQuestion.includes("tôi không hiểu lựa chọn của bạn")) {
                    isChotDonGiaiDoan3 = true;
                }
            }
        }
        
        let systemPrompt;
        let toolChoice;
        
        if (isChotDonGiaiDoan3) {
            systemPrompt = getSystemPrompt_ChotVe();
            toolChoice = "none";
            console.log("[Agent] PHÁT HIỆN GIAI ĐOẠN 3 (CHỐT ĐƠN). Dùng prompt chuyên dụng + JSON mode.");
        } else {
            systemPrompt = getSystemPrompt_Normal(user, availableMoviesList, availableCitiesList, availableCinemasList);
            toolChoice = "auto";
            console.log("[Agent] Giai Đoạn 1/2 (Tra cứu/Chat). Dùng prompt tiêu chuẩn.");
        }
        
        const messagesForLLM = [
            { role: "system", content: systemPrompt },
            ...conversationHistory
        ];

        const completionConfig = {
            model: "moonshotai/kimi-k2-instruct-0905", // <-- SỬA LỖI: DÙNG MODEL MIXTRAL
            messages: messagesForLLM,
            tools: tools,
            tool_choice: toolChoice
        };

        if (isChotDonGiaiDoan3) {
            completionConfig.response_format = { type: "json_object" };
            delete completionConfig.tools; 
            delete completionConfig.tool_choice;
        }

        // BƯỚC 4: Gọi Groq
        console.log("[Agent] Bắt đầu LLM Call 1 (Quyết định)...");
        const response = await groq.chat.completions.create(completionConfig);
        const responseMessage = response.choices[0].message;

        // BƯỚC 5: Xử lý Phản hồi của Groq
        const toolCalls = responseMessage.tool_calls;

        if (toolCalls && toolCalls.length > 0) {
            // TRƯỜNG HỢP 1: BOT MUỐN GỌI TOOL
            console.log(`[Agent] LLM Call 1 yêu cầu chạy ${toolCalls.length} tool.`);
            
            // 5a. Lưu hành động "gọi tool" của bot vào DB (chỉ nếu đã đăng nhập)
            if (userId) {
                await client.query(
                    `INSERT INTO ChatHistory (conversation_id, user_id, sender, content, metadata)
                     VALUES ($1, $2, 'assistant', $3, $4)`,
                    [convId, userId, responseMessage.content, { tool_calls: toolCalls }]
                );
            }
            messagesForLLM.push(responseMessage); // Thêm vào lịch sử tạm thời cho Call 2

            // 5b. Thực thi các tool (logic cũ)
            const toolPromises = toolCalls.map(async (toolCall) => {
                const functionName = toolCall.function.name;
                const functionArgs = JSON.parse(toolCall.function.arguments);
                let functionResponse = "";

                console.log(`[Agent] Chuẩn bị chạy tool: ${functionName} với args:`, functionArgs);

                if (functionName === "get_showtimes_for_movie") {
                    functionResponse = await get_showtimes_for_movie(functionArgs);
                } else if (functionName === "get_movies_at_cinema") {
                    functionResponse = await get_movies_at_cinema(functionArgs.cinema_name, functionArgs.date);
                } else if (functionName === "get_movie_details") {
                    functionResponse = await get_movie_details(functionArgs.movie_title);
                } else if (functionName === "get_movie_recommendations_based_on_history") {
                    // (Req 3 & 4) Chặn khách dùng tool này
                    if (!userId) {
                        functionResponse = JSON.stringify({ message: "Vui lòng đăng nhập để tôi có thể đưa ra đề xuất phim dựa trên lịch sử xem phim của bạn." });
                    } else {
                        functionResponse = await get_movie_recommendations_based_on_history(userId);
                    }
                } else {
                    functionResponse = JSON.stringify({ error: "Tool không xác định." });
                }

                console.log(`[Agent] Kết quả tool ${functionName}: ${functionResponse.substring(0, 100)}...`);

                // 5c. Lưu kết quả tool vào DB (chỉ nếu đã đăng nhập)
                if (userId) {
                    await client.query(
                        `INSERT INTO ChatHistory (conversation_id, user_id, sender, content, metadata)
                         VALUES ($1, $2, 'tool', $3, $4)`,
                        [convId, userId, functionResponse, { tool_call_id: toolCall.id, name: functionName }]
                    );
                }
                return { role: "tool", tool_call_id: toolCall.id, name: functionName, content: functionResponse };
            });

            const toolResults = await Promise.all(toolPromises);
            
            // Logic kiểm tra toolFailed (giữ nguyên)
            let toolFailed = false;
            let failureMessage = "";
            try {
                const firstResultContent = toolResults[0].content;
                const parsedResult = JSON.parse(firstResultContent);
                if (parsedResult.message) {
                    toolFailed = true;
                    failureMessage = parsedResult.message;
                } else if (Array.isArray(parsedResult) && parsedResult.length === 0) {
                    toolFailed = true;
                    failureMessage = "Rất tiếc, tôi không tìm thấy suất chiếu nào phù hợp với yêu cầu của bạn.";
                }
            } catch (e) { /* Lỗi parse, không sao */ }

            if (toolFailed) {
                // Lưu câu trả lời lỗi vào DB
                if(userId) {
                    await client.query(
                        `INSERT INTO ChatHistory (conversation_id, user_id, sender, content)
                         VALUES ($1, $2, 'assistant', $3)`,
                        [convId, userId, failureMessage]
                    );
                }
                await client.query('COMMIT'); 
                res.json({ reply: failureMessage, conversation_id: convId }); 
                return; 
            }

            // 5d. Gọi LLM Call 2 (Tổng hợp)
            console.log("[Agent] Bắt đầu LLM Call 2 (Tổng hợp)...");
            messagesForLLM.push(...toolResults); // Thêm kết quả tool vào context
            const finalResponse = await groq.chat.completions.create({
                model: "moonshotai/kimi-k2-instruct-0905", // <-- SỬA LỖI: DÙNG MODEL MIXTRAL
                messages: messagesForLLM
            });

            const reply = finalResponse.choices[0].message.content;

            // 5e. Lưu câu trả lời tổng hợp của bot vào DB (chỉ nếu đã đăng nhập)
            if(userId) {
                await client.query(
                    `INSERT INTO ChatHistory (conversation_id, user_id, sender, content)
                     VALUES ($1, $2, 'assistant', $3)`,
                    [convId, userId, reply]
                );
            }
            await client.query('COMMIT'); 
            res.json({ reply: reply, conversation_id: convId });

        } else {
            // TRƯỜNG HỢP 2: BOT CHỈ CHAT (Hoặc Giai Đoạn 3)
            const replyContent = response.choices[0].message.content || "Xin lỗi, tôi chưa thể trả lời câu hỏi này.";
            let finalReply = replyContent; 
            let bookingData = null; 
            
            if (isChotDonGiaiDoan3) {
                console.log("[Agent] Đang xử lý phản hồi Giai Đoạn 3 (JSON mode):", replyContent);
                try {
                    const choiceJson = JSON.parse(replyContent);
                    
                    // Lấy `lastToolMessage` từ lịch sử (an toàn)
                    const lastToolMessage = [...conversationHistory].reverse().find(m => m.role === 'tool');
                    
                    if (!lastToolMessage) throw new Error("Không tìm thấy tin nhắn tool (suất chiếu) trong lịch sử.");

                    const allShowtimes = JSON.parse(lastToolMessage.content); 
                    if (!Array.isArray(allShowtimes) || allShowtimes.length === 0) throw new Error("Dữ liệu suất chiếu (tool) bị hỏng hoặc rỗng.");

                    let selectedShowtime = null;

                    if (choiceJson.choice_index) {
                        if (choiceJson.choice_index === -1) {
                            finalReply = "Đã hiểu. Bạn cần tôi giúp gì khác không?";
                        } else {
                            selectedShowtime = allShowtimes[choiceJson.choice_index - 1];
                        }
                    } else if (choiceJson.choice_time) {
                        const targetTime = choiceJson.choice_time; // Ví dụ: "12:30"
                        console.log(`[Agent-Debug] Target time (từ user) là: "${targetTime}"`); // <-- DEBUG 1
                        
                        selectedShowtime = allShowtimes.find(st => {
                            // st.start_time là chuỗi UTC từ CSDL, ví dụ: "2025-11-17T05:30:00.000Z"
                            
                            // 1. Tạo đối tượng Date (nó sẽ ở múi giờ UTC)
                            const dateUTC = new Date(st.start_time);

                            // 2. Lấy giờ và phút theo UTC
                            const utcHours = dateUTC.getUTCHours();
                            const utcMinutes = dateUTC.getUTCMinutes();

                            // 3. Tự cộng 7 tiếng để ra giờ Việt Nam (UTC+7)
                            let vnHours = utcHours + 7;
                            
                            // 4. Xử lý trường hợp qua ngày mới (ví dụ: 18:00 UTC + 7 = 25:00 -> 01:00)
                            if (vnHours >= 24) {
                                vnHours = vnHours - 24;
                            }

                            // 5. Định dạng lại thành chuỗi "HH:mm"
                            const hStr = String(vnHours).padStart(2, '0');
                            const mStr = String(utcMinutes).padStart(2, '0');
                            const stTime = `${hStr}:${mStr}`; // Sẽ ra "12:30"

                            // 6. So sánh
                            console.log(`[Agent-Debug] Đang so sánh: (Suất chiếu) "${stTime}" === (User) "${targetTime}"`); // <-- DEBUG 2
                            return stTime === targetTime;
                        });

                        if (!selectedShowtime) {
                            con2sole.log(`[Agent-Debug] SO SÁNH THẤT BẠI cho tất cả suất chiếu.`); // <-- DEBUG 3
                        }
                    }

                    if (!selectedShowtime && finalReply === replyContent) {
                        throw new Error("Không thể ghép nối lựa chọn của user với suất chiếu.");
                    }

                    if (selectedShowtime) {
                        console.log("[Agent] Đã tìm thấy suất chiếu:", selectedShowtime.showtime_id);
                        finalReply = JSON.stringify([selectedShowtime]); 
                        bookingData = [selectedShowtime]; // Dữ liệu này sẽ được client xử lý
                    }

                } catch (e) {
                    console.error("[Agent] Lỗi nghiêm trọng Giai Đoạn 3:", e.message, replyContent);
                    finalReply = "Rất tiếc, tôi không hiểu lựa chọn của bạn. Vui lòng thử lại bằng cách nói rõ giờ chiếu (ví dụ: 'chọn suất 13:45').";
                }
            } 

            // 5f. Lưu câu trả lời của bot vào DB (chỉ nếu đã đăng nhập)
            if(userId) {
                await client.query(
                    `INSERT INTO ChatHistory (conversation_id, user_id, sender, content, metadata)
                     VALUES ($1, $2, 'assistant', $3, $4)`,
                    [convId, userId, finalReply, (bookingData ? { bookingData: bookingData } : null)]
                );
            }
            
            await client.query('COMMIT'); 
            res.json({ reply: finalReply, conversation_id: convId });
        }

    } catch (err) {
        await client.query('ROLLBACK'); 
        console.error("Lỗi API Chat:", err);
        if (err instanceof Groq.APIError) {
             console.error("Chi tiết lỗi Groq:", err.response ? await err.response.text() : err.message);
             return res.status(500).json({ message: 'Lỗi từ nhà cung cấp AI. Có thể bạn đã vượt giới hạn (rate limit) hoặc prompt có vấn đề.' });
        }
        res.status(500).json({ message: 'Lỗi server khi xử lý yêu cầu chat.' });
    } finally {
        client.release(); 
    }
});

// === API MỚI: LẤY LỊCH SỬ CHAT KHI TẢI LẠI TRANG ===
app.get('/api/chat/history', authMiddleware, async (req, res) => {
    // Endpoint này BẮT BUỘC phải đăng nhập
    if (!req.user) {
        return res.status(401).json({ message: 'Cần đăng nhập để lấy lịch sử chat.' });
    }
    
    const userId = req.user.id;
    const client = await pool.connect(); // Dùng client riêng
    
    try {
        // 1. Tìm conversation_id gần đây nhất của user
        const lastConvRes = await client.query(
            `SELECT conversation_id, MAX(created_at) as last_message_time 
             FROM ChatHistory 
             WHERE user_id = $1 
             GROUP BY conversation_id 
             ORDER BY last_message_time DESC 
             LIMIT 1`,
            [userId]
        );

        if (lastConvRes.rows.length === 0) {
            // User này chưa chat bao giờ
            return res.json({ conversation_id: null, messages: [] });
        }

        const convId = lastConvRes.rows[0].conversation_id;
        const lastMessageTime = new Date(lastConvRes.rows[0].last_message_time);
        const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

        // (Req 2) Kiểm tra 6 tiếng
        if (lastMessageTime < sixHoursAgo) {
            // Phiên cũ đã hết hạn
            return res.json({ conversation_id: null, messages: [] });
        }

        // 2. Lấy tất cả tin nhắn của phiên còn hạn đó
        const messagesRes = await client.query(
            `SELECT message_id, sender, content, metadata, created_at 
             FROM ChatHistory 
             WHERE conversation_id = $1 
             ORDER BY created_at ASC`,
            [convId]
        );
        
        // 3. Định dạng lại cho frontend
        const formattedMessages = messagesRes.rows.map(row => {
            // Chỉ gửi những gì client cần: sender, content (text), và bookingData (nếu có)
            let bookingData = null;
            if (row.sender === 'assistant' && row.metadata?.bookingData) {
                bookingData = row.metadata.bookingData[0]; // Lấy object suất chiếu
            }
            
            // Chúng ta chỉ gửi về các tin nhắn 'user' và 'assistant' (không gửi 'tool')
            if (row.sender === 'user' || row.sender === 'assistant') {
                return {
                    id: `db-${row.message_id}`,
                    text: row.content, // finalReply (có thể là JSON string của bookingData)
                    sender: row.sender,
                    timestamp: new Date(row.created_at),
                    bookingData: bookingData // Sẽ là null trừ phi đó là tin nhắn chốt đơn
                };
            }
        }).filter(Boolean); // Lọc ra các tin nhắn 'tool'

        res.json({
            conversation_id: convId,
            messages: formattedMessages
        });

    } catch (err) {
        console.error("Lỗi khi lấy lịch sử chat:", err);
        res.status(500).json({ message: 'Lỗi server khi lấy lịch sử chat.' });
    } finally {
        client.release();
    }
});


// === CÁC API KHÁC (Được giữ nguyên) ===
// 1. API gốc
app.get('/', (req, res) => res.send('Backend server CGV đã chạy thành công!'));

// 2. API Đăng ký
app.post('/api/auth/register', async (req, res) => {
    // SỬA: Bổ sung các trường mới từ req.body
    const { name, email, password, phone, birthday, address, gender } = req.body;
    
    if (!name || !email || !password) return res.status(400).json({ message: 'Vui lòng cung cấp đủ thông tin bắt buộc.' });

    // SỬA: Xử lý giá trị null/undefined cho các trường tùy chọn
    // Nếu giá trị là chuỗi rỗng "", chuyển thành null để DB chấp nhận
    const birthdayValue = birthday ? birthday : null;
    const phoneValue = phone ? phone : null;
    const addressValue = address ? address : null;
    const genderValue = gender ? gender : 'other'; // Đặt 'other' làm mặc định

    try {
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password.trim(), salt);
        
        // SỬA: Cập nhật câu query INSERT
        const newUserQuery = `
            INSERT INTO Users (username, email, password_hash, phone, birthday, address, gender) 
            VALUES ($1, $2, $3, $4, $5, $6, $7) 
            RETURNING user_id, username, email;
        `;
        
        // SỬA: Cập nhật mảng values
        const values = [
            name.trim(), 
            email.trim().toLowerCase(), 
            password_hash,
            phoneValue,
            birthdayValue,
            addressValue,
            genderValue
        ];
        
        const result = await pool.query(newUserQuery, values);
        res.status(201).json({ message: 'Tạo tài khoản thành công!', user: result.rows[0] });
    } catch (err) {
        // Đây là thông báo lỗi chúng ta đã sửa ở bước trước
        if (err.code === '23505') return res.status(400).json({ message: 'Email này đã tồn tại. Vui lòng sử dụng email khác.' });
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});


// 3. API Đăng nhập
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Vui lòng cung cấp email và mật khẩu.' });
    try {
        const userQuery = 'SELECT * FROM Users WHERE email = $1';
        const result = await pool.query(userQuery, [email.trim().toLowerCase()]);
        if (result.rows.length === 0) return res.status(401).json({ message: 'Email hoặc mật khẩu không chính xác.' });
        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password.trim(), user.password_hash);
        if (!isMatch) return res.status(401).json({ message: 'Email hoặc mật khẩu không chính xác.' });
        const payload = { user: { id: user.user_id, name: user.username, email: user.email } };
        jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' }, (err, token) => {
            if (err) throw err;
            res.status(200).json({ message: 'Đăng nhập thành công!', token: token, user: payload.user });
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 4. API Lấy thông tin người dùng
app.get('/api/users/me', authMiddleware, async (req, res) => {
    try {
        const userQuery = 'SELECT user_id, username, email, phone, birthday, address, gender FROM Users WHERE user_id = $1';
        const result = await pool.query(userQuery, [req.user.id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'Không tìm thấy người dùng.' });
        // Format birthday before sending
        const user = result.rows[0];
        if (user.birthday) {
             user.birthday = new Date(user.birthday).toISOString().split('T')[0]; // Format YYYY-MM-DD
        }
        res.json(user);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 5. API Cập nhật thông tin người dùng
app.put('/api/users/me', authMiddleware, async (req, res) => {
    const { name, phone, birthday, address, gender } = req.body;
    try {
        const birthdayValue = birthday ? birthday : null; // Handle null birthday
        const updateUserQuery = `
            UPDATE Users 
            SET username = $1, phone = $2, birthday = $3, address = $4, gender = $5 
            WHERE user_id = $6 
            RETURNING user_id, username, email, phone, birthday, address, gender;
        `;
        const values = [name, phone, birthdayValue, address, gender, req.user.id];
        const result = await pool.query(updateUserQuery, values);
        // Format birthday before sending back
        const updatedUser = result.rows[0];
         if (updatedUser.birthday) {
             updatedUser.birthday = new Date(updatedUser.birthday).toISOString().split('T')[0];
         }
        res.json({ message: 'Cập nhật thông tin thành công!', user: updatedUser });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 6. API Lấy lịch sử đặt vé (ĐÃ CẬP NHẬT)
app.get('/api/users/me/bookings', authMiddleware, async (req, res) => {
    try {
        const bookingsQuery = `
            SELECT 
                b.booking_id, 
                m.title AS movie_title, 
                m.poster_url,
                m.genre,
                c.name AS cinema_name, 
                s.start_time, 
                b.total_amount,
                b.seats 
            FROM Bookings b 
            JOIN Showtimes s ON b.showtime_id = s.showtime_id 
            JOIN Movies m ON s.movie_id = m.movie_id
            JOIN Cinemas c ON s.cinema_id = c.cinema_id 
            WHERE b.user_id = $1 
            ORDER BY s.start_time DESC;
        `;
        const result = await pool.query(bookingsQuery, [req.user.id]);
        res.json(result.rows);
    } catch (err) {
        console.error("Lỗi API get bookings:", err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 7. API Lấy danh sách phim (Phiên bản đã sửa lỗi)
app.get('/api/movies', async (req, res) => {
    try {
        const { status } = req.query;
        let query = 'SELECT * FROM Movies ORDER BY release_date DESC';
        
        if (status === 'now-showing') {
            query = "SELECT * FROM Movies WHERE release_date <= CURRENT_DATE ORDER BY release_date DESC";
        } else if (status === 'coming-soon') {
            query = "SELECT * FROM Movies WHERE release_date > CURRENT_DATE ORDER BY release_date ASC";
        }
        
        const result = await pool.query(query);
        // Chuyển đổi định dạng ngày tháng ở phía server trước khi gửi đi
        const movies = result.rows.map(movie => ({
            ...movie,
            // Đảm bảo chỉ chuyển đổi nếu release_date không null
            release_date: movie.release_date ? movie.release_date.toISOString().split('T')[0] : null
        }));

        res.json(movies);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 8. API Lấy danh sách thành phố (Đã sửa để trả về count)
app.get('/api/cinemas/cities', async (req, res) => {
    try {
        const query = 'SELECT city, COUNT(cinema_id)::text as count FROM Cinemas GROUP BY city ORDER BY city'; // Cast count to text
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Lỗi API get cities:", err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 9. API Lấy danh sách rạp phim
app.get('/api/cinemas', async (req, res) => {
    try {
        const { city } = req.query;
        let query = 'SELECT * FROM Cinemas ORDER BY name';
        let values = [];
        if (city && city !== 'all') {
            query = 'SELECT * FROM Cinemas WHERE city = $1 ORDER BY name';
            values.push(city);
        }
        const result = await pool.query(query, values);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});


// 11. API để lấy thông tin chi tiết của một phim
app.get('/api/movies/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const query = "SELECT *, to_char(release_date, 'YYYY-MM-DD') as release_date FROM Movies WHERE movie_id = $1";
        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Không tìm thấy phim.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// 12. API để lấy suất chiếu của một phim (Đã cập nhật để bao gồm thành phố)
app.get('/api/movies/:id/showtimes', async (req, res) => {
    try {
        const { id } = req.params;
        const query = `
            SELECT 
                s.showtime_id,
                s.start_time,
                s.ticket_price,
                c.name as cinema_name,
                c.city
            FROM Showtimes s
            JOIN Cinemas c ON s.cinema_id = c.cinema_id
            WHERE s.movie_id = $1 AND s.start_time > NOW() 
            ORDER BY c.city, c.name, s.start_time;
        `;
        const result = await pool.query(query, [id]);
        res.json(result.rows);
    } catch (err) {
        console.error("Lỗi khi lấy suất chiếu cho phim:", err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});


// 13. API để tạo một booking mới (PHIÊN BẢN CÓ TRANSACTION - ĐÃ SỬA LỖI)
app.post('/api/bookings', authMiddleware, async (req, res) => {
    const { showtime_id, seats } = req.body; // `seats` là một mảng, ví dụ: ['H8', 'H9']
    
    // YÊU CẦU ĐĂNG NHẬP
    if (!req.user) {
        return res.status(401).json({ message: 'Bạn cần đăng nhập để đặt vé.' });
    }
    const userId = req.user.id;

    if (!showtime_id || !seats || !Array.isArray(seats) || seats.length === 0) {
        return res.status(400).json({ message: 'Vui lòng cung cấp đủ thông tin suất chiếu và ghế ngồi.' });
    }

    const client = await pool.connect();

    try {
        // BẮT ĐẦU TRANSACTION
        await client.query('BEGIN');

        // 1. Kiểm tra xem có ghế nào đã được đặt chưa (Sử dụng FOR UPDATE để khóa dòng)
        const checkSeatsQuery = `SELECT seat_id FROM booked_seats WHERE showtime_id = $1 AND seat_id = ANY($2::text[]) FOR UPDATE`;
        const existingSeatsResult = await client.query(checkSeatsQuery, [showtime_id, seats]);

        if (existingSeatsResult.rows.length > 0) {
            const occupied = existingSeatsResult.rows.map(r => r.seat_id).join(', ');
            // SỬA LỖI: Ném lỗi để ROLLBACK và gửi mã lỗi 409
            await client.query('ROLLBACK'); // Hủy transaction
            return res.status(409).json({ message: `Ghế ${occupied} đã có người đặt. Vui lòng chọn ghế khác.` });
        }

        // 2. Lấy giá vé và tính tổng tiền
        const showtimeQuery = 'SELECT ticket_price FROM showtimes WHERE showtime_id = $1';
        const showtimeResult = await client.query(showtimeQuery, [showtime_id]);
        if (showtimeResult.rows.length === 0) {
             // SỬA LỖI: Ném lỗi để ROLLBACK và gửi mã lỗi 404
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Không tìm thấy suất chiếu.' });
        }
        
        // Sửa lỗi tính toán: Dùng giá vé từ DB, *không* dùng hàm logic giá vé cứng ở frontend
        const ticketPrice = parseFloat(showtimeResult.rows[0].ticket_price);
        // Đơn giản hóa: Mọi vé có cùng giá
        const totalAmount = ticketPrice * seats.length; 

        // 3. Tạo một bản ghi mới trong bảng `bookings` với cột `seats`
        const newBookingQuery = `
            INSERT INTO bookings (user_id, showtime_id, total_amount, seats)
            VALUES ($1, $2, $3, $4)
            RETURNING booking_id;
        `;
        const bookingValues = [userId, showtime_id, totalAmount, seats];
        const bookingResult = await client.query(newBookingQuery, bookingValues);
        const newBookingId = bookingResult.rows[0].booking_id;

        // 4. Thêm từng ghế đã đặt vào bảng `booked_seats`
        // (Sử dụng vòng lặp for...of để đảm bảo tuần tự)
        for (const seat_id of seats) {
            const bookSeatQuery = `
                INSERT INTO booked_seats (booking_id, showtime_id, seat_id)
                VALUES ($1, $2, $3);
            `;
            await client.query(bookSeatQuery, [newBookingId, showtime_id, seat_id]);
        }
        
        // 5. Cập nhật lại số ghế trống trong bảng `showtimes`
        const updateShowtimeQuery = `
            UPDATE showtimes 
            SET available_seats = available_seats - $1 
            WHERE showtime_id = $2;
        `;
        await client.query(updateShowtimeQuery, [seats.length, showtime_id]);

        // KẾT THÚC TRANSACTION, LƯU TẤT CẢ THAY ĐỔI
        await client.query('COMMIT');

        res.status(201).json({
            message: 'Đặt vé thành công!',
            bookingId: newBookingId,
        });

    } catch (err) {
        // Nếu có bất kỳ lỗi nào khác (ngoài lỗi đã xử lý ở trên), hủy bỏ tất cả thay đổi
        await client.query('ROLLBACK');
        console.error("Lỗi khi tạo booking:", err);
        // Gửi thông báo lỗi server chung chung
        res.status(500).json({ message: 'Lỗi server khi đặt vé.' });
    } finally {
        // Luôn giải phóng kết nối sau khi hoàn tất
        client.release();
    }
});

// API 15: Lấy danh sách khuyến mãi
app.get('/api/promotions', async (req, res) => {
    try {
        const query = 'SELECT *, to_char(valid_until, \'YYYY-MM-DD\') as valid_until FROM Promotions ORDER BY featured DESC, valid_until ASC';
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Lỗi khi lấy danh sách khuyến mãi:", err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// API 16: Lấy danh sách sự kiện (ĐÃ SỬA LỖI)
app.get('/api/events', async (req, res) => {
    try {
        const query = `
            SELECT 
                *, 
                to_char(event_date, 'YYYY-MM-DD') as event_date 
            FROM Events 
            WHERE event_date > NOW() 
            ORDER BY Events.event_date ASC`; 
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Lỗi khi lấy danh sách sự kiện:", err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// API 17: Lấy lịch chiếu tổng hợp cho một rạp vào một ngày
app.get('/api/showtimes-by-cinema', async (req, res) => {
    const { cinemaId, date } = req.query; // date có định dạng YYYY-MM-DD

    if (!cinemaId || !date) {
        return res.status(400).json({ message: 'Vui lòng cung cấp cinemaId và date.' });
    }

    try {
        const query = `
            SELECT
                m.movie_id, m.title, m.genre, m.duration_minutes, m.rating, m.age_rating, m.poster_url, m.features,
                json_agg(
                    json_build_object(
                        'showtime_id', s.showtime_id,
                        'start_time', s.start_time,
                        'ticket_price', s.ticket_price
                    ) ORDER BY s.start_time
                ) AS times
            FROM Movies m
            JOIN Showtimes s ON m.movie_id = s.movie_id
            WHERE s.cinema_id = $1 
              AND s.start_time >= ($2::date) 
              AND s.start_time < ($2::date + interval '1 day')
              AND s.start_time > NOW()
            GROUP BY m.movie_id
            ORDER BY m.title;
        `;
        const result = await pool.query(query, [cinemaId, date]);
        res.json(result.rows);
    } catch (err) {
        console.error('Lỗi khi lấy lịch chiếu theo rạp:', err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// API 18: Lấy danh sách các ghế đã bị chiếm cho một suất chiếu cụ thể
app.get('/api/showtimes/:showtimeId/occupied-seats', async (req, res) => {
    const { showtimeId } = req.params;
    try {
        const query = 'SELECT seat_id FROM booked_seats WHERE showtime_id = $1';
        const result = await pool.query(query, [showtimeId]);
        res.json(result.rows.map(row => row.seat_id));
    } catch (err) {
        console.error('Lỗi khi lấy danh sách ghế đã chiếm:', err);
        res.status(500).json({ message: 'Lỗi server.' });
    }
});

// API MỚI: Đặt vé sự kiện
app.post('/api/events/bookings', authMiddleware, async(req, res) => {
     const { event_id, number_of_tickets, total_amount } = req.body;
     
     // YÊU CẦU ĐĂNG NHẬP
     if (!req.user) {
        return res.status(401).json({ message: 'Bạn cần đăng nhập để đặt vé sự kiện.' });
     }
     const userId = req.user.id;

     if (!event_id || !number_of_tickets || number_of_tickets <= 0 || !total_amount) {
         return res.status(400).json({ message: 'Thông tin đặt vé sự kiện không hợp lệ.' });
     }

     const client = await pool.connect();
     try {
         await client.query('BEGIN');

         // Tạo booking sự kiện
         const insertBookingQuery = `
            INSERT INTO event_bookings (user_id, event_id, number_of_tickets, total_amount) 
            VALUES ($1, $2, $3, $4) 
            RETURNING event_booking_id;
         `;
         const bookingResult = await client.query(insertBookingQuery, [userId, event_id, number_of_tickets, total_amount]);
         const newBookingId = bookingResult.rows[0].event_booking_id;

         await client.query('COMMIT');
         res.status(201).json({ message: 'Đặt vé sự kiện thành công!', bookingId: newBookingId });

     } catch (err) {
         await client.query('ROLLBACK');
         console.error("Lỗi khi đặt vé sự kiện:", err);
         res.status(500).json({ message: err.message || 'Lỗi server khi đặt vé sự kiện.' });
     } finally {
         client.release();
     }
});


// Lắng nghe server
app.listen(port, () => {
    console.log(`Server đang chạy tại http://localhost:${port}`);
});