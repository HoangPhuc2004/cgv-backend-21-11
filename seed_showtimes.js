require('dotenv').config();
const { Pool } = require('pg');

// Cấu hình kết nối database (tự động lấy từ file .env)
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// Các khung giờ chiếu phim phổ biến
const showtimeSlots = [
  '09:30', '10:45', '12:00', '13:15', '14:30',
  '15:45', '17:00', '18:15', '19:30', '20:45',
  '22:00', '23:15'
];

/**
 * Hàm lấy ngẫu nhiên các suất chiếu từ danh sách
 * @param {number} count - Số lượng suất chiếu cần lấy
 * @returns {string[]} - Mảng các chuỗi thời gian
 */
function getRandomShowtimes(count) {
  // Sao chép và xáo trộn mảng
  const shuffled = [...showtimeSlots].sort(() => 0.5 - Math.random());
  // Lấy 'count' phần tử đầu tiên
  return shuffled.slice(0, count);
}

/**
 * Hàm chính để tạo dữ liệu suất chiếu
 */
async function generateShowtimes() {
  console.log('Bắt đầu quá trình tạo suất chiếu...');
  const client = await pool.connect();

  try {
    // --- 1. Lấy ID của tất cả phim và rạp ---
    const moviesResult = await client.query('SELECT movie_id FROM movies');
    const cinemasResult = await client.query('SELECT cinema_id FROM cinemas');

    const movieIds = moviesResult.rows.map(row => row.movie_id);
    const cinemaIds = cinemasResult.rows.map(row => row.cinema_id);

    // Kiểm tra nếu không có phim hoặc rạp
    if (movieIds.length === 0 || cinemaIds.length === 0) {
      console.log('Không tìm thấy phim hoặc rạp nào trong database. Vui lòng thêm dữ liệu phim và rạp trước.');
      return;
    }

    console.log(`Tìm thấy ${movieIds.length} phim và ${cinemaIds.length} rạp.`);

    let totalShowtimesCreated = 0;

    // --- 2. Lặp trong 14 ngày tới ---
    for (let day = 0; day < 14; day++) {
      const date = new Date();
      date.setDate(date.getDate() + day);
      const dateString = date.toISOString().split('T')[0]; // Format YYYY-MM-DD

      // Lặp qua từng rạp
      for (const cinemaId of cinemaIds) {
        
        // Lặp qua từng phim
        for (const movieId of movieIds) {
          
          // Lấy 5 suất chiếu ngẫu nhiên cho cặp (phim, rạp) này
          const times = getRandomShowtimes(5);

          for (const time of times) {
            const startTime = `${dateString} ${time}:00`;
            // Giá vé ngẫu nhiên từ 80k (8*10000) đến 120k (12*10000)
            const ticketPrice = (Math.floor(Math.random() * 5) + 8) * 10000;

            const insertQuery = `
              INSERT INTO showtimes (movie_id, cinema_id, start_time, ticket_price, available_seats)
              VALUES ($1, $2, $3, $4, $5);
            `;
            
            // Giả sử có 100 ghế ban đầu
            await client.query(insertQuery, [movieId, cinemaId, startTime, ticketPrice, 100]);
            totalShowtimesCreated++;
          }
        }
      }
      console.log(`-> Đã tạo xong suất chiếu cho ngày ${dateString}`);
    }

    console.log(`\n✅ HOÀN TẤT! Đã tạo thành công ${totalShowtimesCreated} suất chiếu.`);

  } catch (error) {
    console.error('❌ Đã xảy ra lỗi:', error);
  } finally {
    // Luôn giải phóng client và đóng pool
    client.release();
    await pool.end();
    console.log('Đã đóng kết nối database.');
  }
}

// Chạy hàm chính
generateShowtimes();