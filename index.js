// index.js - 請假系統 LINE Bot (本地測試版本)
const express = require('express');
const line = require('@line/bot-sdk');
const { google } = require('googleapis');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
require('dotenv').config();

dayjs.extend(utc);
dayjs.extend(timezone);

const app = express();

// LINE Bot 設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

// Google Sheets 設定
const SHEET_CONFIG = {
  '國中': {
    id: '1SOTkqaIN3g4Spk0Cri4F1mEzdiD1xvLzR5x5KLmhrmY',
    name: '國中'
  },
  '先修': {
    id: '14k7fkfiPdhrSnYPXLJ7--8s_Qk3wehI0AZDpgFw83AM',
    name: '先修'
  },
  '兒美': {
    id: '1c7zuwUaz-gzY0hbDDO2coixOcQLGhbZbdUXZ9X63Wfo',
    name: '兒美'
  }
};

// Google 認證
const getGoogleAuth = () => {
  // 如果使用環境變數存放憑證
  if (process.env.GOOGLE_SERVICE_ACCOUNT) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }
  // 如果使用憑證檔案
  return new google.auth.GoogleAuth({
    keyFile: 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
};

// 儲存使用者對話狀態
const userStates = new Map();

// 定期清理過期的對話狀態（10分鐘）
setInterval(() => {
  const now = Date.now();
  for (const [userId, state] of userStates.entries()) {
    if (state.timestamp && now - state.timestamp > 10 * 60 * 1000) {
      userStates.delete(userId);
      console.log(`清理過期對話狀態: ${userId}`);
    }
  }
}, 60 * 1000);

// 建立快速回覆按鈕
function createQuickReply(text, items) {
  return {
    type: 'text',
    text: text,
    quickReply: {
      items: items.slice(0, 13).map(item => ({
        type: 'action',
        action: {
          type: 'message',
          label: item.length > 20 ? item.substring(0, 20) : item,
          text: item
        }
      }))
    }
  };
}

// 解析請假日期
function parseLeaveDate(input) {
  const now = dayjs().tz('Asia/Taipei');
  const today = now.startOf('day');
  let date;
  
  // 清理輸入
  const cleanInput = input.trim().toLowerCase();
  
  // 特殊關鍵字
  if (cleanInput === '今天' || cleanInput === 'today') {
    date = today;
  } else if (cleanInput === '明天' || cleanInput === 'tomorrow') {
    date = today.add(1, 'day');
  } else {
    // 處理中文數字
    let processedInput = cleanInput
      .replace(/一月/g, '1月').replace(/二月/g, '2月').replace(/三月/g, '3月')
      .replace(/四月/g, '4月').replace(/五月/g, '5月').replace(/六月/g, '6月')
      .replace(/七月/g, '7月').replace(/八月/g, '8月').replace(/九月/g, '9月')
      .replace(/十月/g, '10月').replace(/十一月/g, '11月').replace(/十二月/g, '12月')
      .replace(/一日/g, '1日').replace(/二日/g, '2日').replace(/三日/g, '3日')
      .replace(/四日/g, '4日').replace(/五日/g, '5日').replace(/六日/g, '6日')
      .replace(/七日/g, '7日').replace(/八日/g, '8日').replace(/九日/g, '9日')
      .replace(/十日/g, '10日').replace(/二十/g, '2').replace(/三十/g, '3')
      .replace(/十/g, '1').replace(/日/g, '').replace(/月/g, '/');
    
    // 嘗試各種日期格式
    const formats = [
      'YYYY/MM/DD',
      'YYYY-MM-DD',
      'YYYY/M/D',
      'YYYY-M-D',
      'MM/DD',
      'M/D',
      'MM-DD',
      'M-D',
      'DD/MM',
      'D/M',
      'YYYYMMDD'
    ];
    
    // 如果輸入只有月日，補上今年
    if (/^\d{1,2}[\/\-]\d{1,2}$/.test(processedInput)) {
      processedInput = `${now.year()}/${processedInput}`;
    }
    
    // 嘗試解析
    for (const format of formats) {
      const parsed = dayjs(processedInput, format);
      if (parsed.isValid()) {
        date = parsed;
        break;
      }
    }
    
    // 如果還是無效，試試 dayjs 的自動解析
    if (!date || !date.isValid()) {
      date = dayjs(processedInput);
    }
  }
  
  // 驗證日期
  if (!date || !date.isValid()) {
    return {
      isValid: false,
      error: '日期格式不正確，請使用如 6月20日、6/20 或 2024/6/20 的格式'
    };
  }
  
  // 檢查是否為過去的日期
  if (date.isBefore(today)) {
    return {
      isValid: false,
      error: '不能請過去的假，請選擇今天或之後的日期'
    };
  }
  
  // 檢查是否超過合理範圍（1個月內）
  const maxDate = today.add(1, 'month');
  if (date.isAfter(maxDate)) {
    return {
      isValid: false,
      error: '請假日期不能超過1個月'
    };
  }
  
  return {
    isValid: true,
    date: date.format('YYYY-MM-DD'),
    displayDate: date.format('YYYY年MM月DD日')
  };
}

// 取得指定年級的所有班級
async function getClassesFromGrade(gradeName) {
  const gradeConfig = SHEET_CONFIG[gradeName];
  if (!gradeConfig) return [];
  
  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    
    const meta = await sheets.spreadsheets.get({ 
      spreadsheetId: gradeConfig.id,
      fields: 'sheets.properties.title'
    });
    
    return meta.data.sheets.map(sheet => sheet.properties.title);
  } catch (error) {
    console.error('取得班級列表失敗:', error);
    return [];
  }
}

// 取得班級中的所有學生
async function getStudentsFromClass(gradeName, className) {
  const gradeConfig = SHEET_CONFIG[gradeName];
  if (!gradeConfig) return [];
  
  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: gradeConfig.id,
      range: `${className}!A1:Z1000`,
    });
    
    if (!res.data.values || res.data.values.length === 0) return [];
    
    const [header, ...rows] = res.data.values;
    const nameCol = header.indexOf('姓名');
    
    if (nameCol === -1) return [];
    
    // 取得所有學生姓名（去重）
    const students = [...new Set(rows.map(row => row[nameCol]).filter(name => name && name.trim()))];
    return students;
  } catch (error) {
    console.error('取得學生列表失敗:', error);
    return [];
  }
}

// 記錄請假
async function recordLeave(gradeName, className, studentName, leaveDate, leaveType = '請假') {
  const gradeConfig = SHEET_CONFIG[gradeName];
  if (!gradeConfig) throw new Error('找不到年級');
  
  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    
    // 使用指定的請假日期
    const targetDate = leaveDate;
    
    // 讀取試算表資料
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: gradeConfig.id,
      range: `${className}!A1:Z1000`,
    });
    
    if (!res.data.values || res.data.values.length === 0) {
      throw new Error('找不到班級資料');
    }
    
    const [header, ...rows] = res.data.values;
    const nameCol = header.indexOf('姓名');
    const dateCol = header.indexOf(targetDate);
    
    if (nameCol === -1) throw new Error('找不到姓名欄位');
    if (dateCol === -1) throw new Error(`找不到 ${targetDate} 的日期欄位，請確認試算表已建立該日期欄位`);
    
    // 找到學生
    let studentRowIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][nameCol] === studentName) {
        studentRowIndex = i;
        break;
      }
    }
    
    if (studentRowIndex === -1) throw new Error('找不到該學生');
    
    // 計算儲存格位置
    const rowNumber = studentRowIndex + 2;
    const colLetter = String.fromCharCode(65 + dateCol);
    const cell = `${colLetter}${rowNumber}`;
    
    // 檢查是否已有記錄
    const currentValue = rows[studentRowIndex][dateCol] || '';
    if (currentValue.includes('出席')) {
      throw new Error(`該學生在 ${targetDate} 已簽到（${currentValue}），無法請假`);
    }
    if (currentValue.includes('請假')) {
      throw new Error(`該學生在 ${targetDate} 已請假`);
    }
    
    // 更新為請假
    await sheets.spreadsheets.values.update({
      spreadsheetId: gradeConfig.id,
      range: `${className}!${cell}`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[leaveType]],
      },
    });
    
    return {
      success: true,
      date: targetDate,
      student: studentName,
      class: className,
      grade: gradeName,
      type: leaveType
    };
    
  } catch (error) {
    throw error;
  }
}

// 處理 LINE Webhook
app.post('/webhook', line.middleware(config), async (req, res) => {
  console.log('收到 LINE Webhook - 請假系統');
  
  try {
    const events = req.body.events || [];
    
    for (const event of events) {
      await handleEvent(event);
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('Webhook 處理錯誤:', err);
    res.status(500).json({ error: err.message });
  }
});

// 處理事件
async function handleEvent(event) {
  // 處理加好友事件
  if (event.type === 'follow') {
    const userId = event.source.userId;
    console.log('新用戶加入請假系統:', userId);
    
    return client.replyMessage(event.replyToken, [
      {
        type: 'text',
        text: `🎓 歡迎使用育名補習班請假系統\n\n您的 LINE ID：${userId}\n請將此 ID 提供給班主任進行身份認證`
      },
      {
        type: 'text',
        text: '📋 系統功能說明\n\n' +
              '【主要功能】\n' +
              '▪️ 請假申請：幫孩子請病假、事假\n' +
              '▪️ 支援年級：國中、先修、兒美\n' +
              '▪️ 請假時間：可請當天或預先請假（最多1個月內）\n\n' +
              '【使用步驟】\n' +
              '1️⃣ 輸入「請假」開始\n' +
              '2️⃣ 選擇年級（國中/先修/兒美）\n' +
              '3️⃣ 選擇班級名稱\n' +
              '4️⃣ 輸入學生中文姓名（需完全正確）\n' +
              '5️⃣ 輸入請假日期\n' +
              '6️⃣ 選擇請假類型（病假/事假/其他）\n\n' +
              '【日期格式範例】\n' +
              '• 今天、明天\n' +
              '• 6月20日、六月二十日\n' +
              '• 6/20、06/20\n' +
              '• 2024/6/20、2024-06-20\n\n' +
              '【其他指令】\n' +
              '• 輸入「我的ID」- 查看您的 LINE ID\n' +
              '• 輸入「說明」- 重新顯示使用說明\n' +
              '• 輸入「取消」- 中止請假流程\n\n' +
              '【注意事項】\n' +
              '⚠️ 本系統僅支援單日請假\n' +
              '⚠️ 如需請假超過一天，請直接聯絡老師\n' +
              '⚠️ 學生姓名需輸入中文全名\n' +
              '⚠️ 已簽到的學生無法請假\n' +
              '⚠️ 無法請過去日期的假'
      },
      createQuickReply('請問需要什麼協助？', ['請假', '我的ID', '說明'])
    ]);
  }
  
  // 處理文字訊息
  if (event.type === 'message' && event.message.type === 'text') {
    const userId = event.source.userId;
    const text = event.message.text.trim();
    console.log('收到訊息:', text, 'from', userId);
    
    // 取得或初始化用戶狀態
    let userState = userStates.get(userId) || { step: 'idle' };
    
    // 優先處理取消指令 - 在任何步驟都可以取消
    if (text === '取消' || text === 'cancel') {
      if (userState.step !== 'idle') {
        userStates.delete(userId);
        return client.replyMessage(event.replyToken, [{
          type: 'text',
          text: '請假流程已取消。\n\n如需請假，請再次輸入「請假」。'
        }]);
      } else {
        return client.replyMessage(event.replyToken, [{
          type: 'text',
          text: '目前沒有進行中的請假流程。\n\n如需請假，請輸入「請假」。'
        }]);
      }
    }
    
    // 處理請假流程
    if (text.includes('請假') && userState.step === 'idle') {
      // 開始請假流程
      userState = { 
        step: 'select_grade',
        timestamp: Date.now()
      };
      userStates.set(userId, userState);
      
      const grades = Object.keys(SHEET_CONFIG);
      return client.replyMessage(event.replyToken, [
        createQuickReply('請選擇學生的年級：', [...grades, '取消'])
      ]);
      
    } else if (userState.step === 'select_grade') {
      // 選擇年級
      if (!SHEET_CONFIG[text]) {
        return client.replyMessage(event.replyToken, [
          createQuickReply('❌ 請選擇正確的年級：', [...Object.keys(SHEET_CONFIG), '取消'])
        ]);
      }
      
      userState.grade = text;
      userState.step = 'select_class';
      userState.timestamp = Date.now();
      userStates.set(userId, userState);
      
      // 取得該年級的所有班級
      const classes = await getClassesFromGrade(text);
      if (classes.length === 0) {
        userStates.delete(userId);
        return client.replyMessage(event.replyToken, [{
          type: 'text',
          text: '❌ 無法取得班級列表，請稍後再試'
        }]);
      }
      
      // 根據班級數量決定顯示方式
      if (classes.length > 12) {  // 留一個位置給取消按鈕
        return client.replyMessage(event.replyToken, [{
          type: 'text',
          text: `${text}共有 ${classes.length} 個班級，請選擇班級名稱：\n\n${classes.join('\n')}\n\n或輸入「取消」結束請假流程`
        }]);
      } else {
        return client.replyMessage(event.replyToken, [
          createQuickReply('請選擇班級：', [...classes, '取消'])
        ]);
      }
      
    } else if (userState.step === 'select_class') {
      // 選擇班級
      userState.class = text;
      userState.step = 'select_student';
      userState.timestamp = Date.now();
      userStates.set(userId, userState);
      
      // 取得該班級的所有學生
      const students = await getStudentsFromClass(userState.grade, text);
      if (students.length === 0) {
        userStates.delete(userId);
        return client.replyMessage(event.replyToken, [{
          type: 'text',
          text: '❌ 找不到班級或班級中沒有學生'
        }]);
      }
      
      // 不顯示學生名單，直接要求輸入
      return client.replyMessage(event.replyToken, [{
        type: 'text',
        text: `請輸入要請假的學生姓名：`
      }, {
        type: 'text',
        text: `💡 提醒：請輸入中文全名\n\n如需取消請假，請點選下方「取消」按鈕`,
        quickReply: {
          items: [{
            type: 'action',
            action: {
              type: 'message',
              label: '取消',
              text: '取消'
            }
          }]
        }
      }]);
      
    } else if (userState.step === 'select_student') {
      // 選擇學生後詢問請假日期
      userState.student = text;
      userState.step = 'select_leave_date';
      userState.timestamp = Date.now();
      userStates.set(userId, userState);
      
      const today = dayjs().tz('Asia/Taipei').format('MM/DD');
      const tomorrow = dayjs().tz('Asia/Taipei').add(1, 'day').format('MM/DD');
      
      return client.replyMessage(event.replyToken, [{
        type: 'text',
        text: `請輸入請假日期：\n\n` +
              `📅 可接受的格式：\n` +
              `• ${today} 或 ${dayjs().tz('Asia/Taipei').format('M月D日')}\n` +
              `• ${dayjs().tz('Asia/Taipei').format('YYYY/MM/DD')}\n` +
              `• ${dayjs().tz('Asia/Taipei').format('YYYY-MM-DD')}\n` +
              `• 今天、明天\n` +
              `• 六月二十日（中文也可以）\n\n` +
              `⚠️ 只能請今天或之後的日期（最多1個月內）`,
        quickReply: {
          items: [
            {
              type: 'action',
              action: {
                type: 'message',
                label: '今天',
                text: '今天'
              }
            },
            {
              type: 'action',
              action: {
                type: 'message',
                label: '明天',
                text: '明天'
              }
            },
            {
              type: 'action',
              action: {
                type: 'message',
                label: '取消',
                text: '取消'
              }
            }
          ]
        }
      }]);
      
    } else if (userState.step === 'select_leave_date') {
      // 解析並驗證日期
      const parsedDate = parseLeaveDate(text);
      
      if (!parsedDate.isValid) {
        return client.replyMessage(event.replyToken, [{
          type: 'text',
          text: `❌ ${parsedDate.error}\n\n請重新輸入日期（例如：${dayjs().tz('Asia/Taipei').format('MM/DD')}）`
        }]);
      }
      
      userState.leaveDate = parsedDate.date;
      userState.step = 'select_leave_type';
      userState.timestamp = Date.now();
      userStates.set(userId, userState);
      
      return client.replyMessage(event.replyToken, [
        createQuickReply(`請假日期：${parsedDate.displayDate}\n\n請選擇請假類型：`, ['病假', '事假', '其他', '取消'])
      ]);
      
    } else if (userState.step === 'select_leave_type') {
      // 記錄請假
      try {
        const leaveType = text === '病假' ? '請假(病假)' : 
                         text === '事假' ? '請假(事假)' : 
                         text === '其他' ? '請假' : '請假';
        
        const result = await recordLeave(
          userState.grade, 
          userState.class, 
          userState.student,
          userState.leaveDate,  // 加入請假日期
          leaveType
        );
        
        const displayDate = dayjs(result.date).format('YYYY年MM月DD日');
        const confirmMessage = `✅ 請假成功！\n\n` +
          `📅 請假日期：${displayDate}\n` +
          `👤 學生：${result.student}\n` +
          `🏫 班級：${result.grade} ${result.class}\n` +
          `📝 類型：${text}\n\n` +
          `請假記錄已更新至系統。`;
        
        userStates.delete(userId);
        
        return client.replyMessage(event.replyToken, [
          {
            type: 'text',
            text: confirmMessage
          },
          createQuickReply('需要其他協助嗎？', ['再次請假', '說明', '完成'])
        ]);
        
      } catch (error) {
        console.error('請假失敗:', error);
        userStates.delete(userId);
        return client.replyMessage(event.replyToken, [{
          type: 'text',
          text: `❌ 請假失敗\n\n原因：${error.message}`
        }]);
      }
      
    } else if (['我的ID', 'ID', 'id'].includes(text.toLowerCase())) {
      // 查詢 User ID
      return client.replyMessage(event.replyToken, [
        {
          type: 'text',
          text: `🆔 您的 LINE User ID：\n${userId}`
        },
        createQuickReply('需要其他協助嗎？', ['請假', '說明'])
      ]);
      
    } else if (text === '說明') {
      // 功能說明
      return client.replyMessage(event.replyToken, [
        {
          type: 'text',
          text: '📋 系統功能說明\n\n' +
                '【主要功能】\n' +
                '▪️ 請假申請：幫孩子請病假、事假\n' +
                '▪️ 支援年級：國中、先修、兒美\n' +
                '▪️ 請假時間：可請當天或預先請假（最多1個月內）\n\n' +
                '【使用步驟】\n' +
                '1️⃣ 輸入「請假」開始\n' +
                '2️⃣ 選擇年級（國中/先修/兒美）\n' +
                '3️⃣ 選擇班級名稱\n' +
                '4️⃣ 輸入學生中文姓名（需完全正確）\n' +
                '5️⃣ 輸入請假日期\n' +
                '6️⃣ 選擇請假類型（病假/事假/其他）\n\n' +
                '【日期格式範例】\n' +
                '• 今天、明天\n' +
                '• 6/20、06/20\n' +
                '• 2024/6/20、2024-06-20\n\n' +
                '【其他指令】\n' +
                '• 輸入「我的ID」- 查看您的 LINE ID\n' +
                '• 輸入「說明」- 重新顯示使用說明\n' +
                '• 輸入「取消」- 中止請假流程\n\n' +
                '【注意事項】\n' +
                '⚠️ 本系統僅支援單日請假\n' +
                '⚠️ 如需請假超過一天，請直接聯絡老師\n' +
                '⚠️ 學生姓名需輸入中文全名\n' +
                '⚠️ 已簽到的學生無法請假\n' +
                '⚠️ 無法請過去日期的假'
        },
        createQuickReply('請選擇功能：', ['請假', '我的ID'])
      ]);
      
    } else if (text === '取消') {
      // 取消當前操作
      if (userState.step !== 'idle') {
        userStates.delete(userId);
        return client.replyMessage(event.replyToken, [
          {
            type: 'text',
            text: '已取消請假流程。'
          },
          createQuickReply('需要什麼協助？', ['請假', '說明'])
        ]);
      }
      
    } else if (text === '再次請假') {
      // 重新開始請假流程
      userState = { 
        step: 'select_grade',
        timestamp: Date.now()
      };
      userStates.set(userId, userState);
      
      const grades = Object.keys(SHEET_CONFIG);
      return client.replyMessage(event.replyToken, [
        createQuickReply('請選擇學生的年級：', grades)
      ]);
      
    } else if (text === '完成') {
      return client.replyMessage(event.replyToken, [{
        type: 'text',
        text: '感謝使用請假系統！'
      }]);
      
    } else if (userState.step === 'idle') {
      // 不在流程中的其他訊息
      return client.replyMessage(event.replyToken, [
        createQuickReply('請問需要什麼協助？', ['請假', '我的ID', '說明'])
      ]);
    }
  }
  
  return Promise.resolve(null);
}

// 健康檢查端點
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// 首頁
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>請假系統 LINE Bot</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; background-color: #f5f5f5; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #333; }
        .status { background: #4CAF50; color: white; padding: 10px 20px; border-radius: 5px; display: inline-block; }
        .info { margin: 20px 0; padding: 20px; background: #f9f9f9; border-radius: 5px; }
        code { background: #e0e0e0; padding: 2px 5px; border-radius: 3px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>請假系統 LINE Bot</h1>
        <div class="status">✅ 系統運行中</div>
        
        <div class="info">
          <h2>測試步驟：</h2>
          <ol>
            <li>在新終端機執行：<code>npx ngrok http ${process.env.PORT || 3000}</code></li>
            <li>複製 ngrok 提供的 https URL</li>
            <li>在 LINE Developers Console 設定 Webhook URL：<code>https://xxxxx.ngrok.io/webhook</code></li>
            <li>加入你的 LINE Bot 開始測試</li>
          </ol>
        </div>
        
        <div class="info">
          <h2>系統功能：</h2>
          <ul>
            <li>自動回傳 User ID（加入好友時）</li>
            <li>支援三個年級：國中、先修、兒美</li>
            <li>完整請假流程</li>
            <li>防止重複請假</li>
          </ul>
        </div>
      </div>
    </body>
    </html>
  `);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`\n🚀 請假系統啟動成功！`);
  console.log(`📡 監聽 port: ${port}`);
  console.log(`🔗 本地 URL: http://localhost:${port}`);
  console.log(`\n下一步：`);
  console.log(`1. 開啟新終端機執行: npx ngrok http ${port}`);
  console.log(`2. 複製 ngrok 提供的 https URL`);
  console.log(`3. 在 LINE Developers Console 設定 Webhook URL`);
  console.log(`4. 開始測試！\n`);
});

// 優雅關閉
process.on('SIGTERM', () => {
  console.log('收到 SIGTERM 信號，準備關閉伺服器...');
  process.exit(0);
});

// 如果使用 Vercel，需要 export
module.exports = app;