/* ============================================================
   notice-presets.js — 通告快速模板
   ------------------------------------------------------------
   由真實通告（PDF）抽出「最重要嘅內容」，一撳就填好開新通告嘅表，
   執委只需要改日期／加減欄位就可以發布 + WhatsApp 分享 + 收報名。

   模板資料係純資料（唔會連任何網站）：套用之後仍然可以逐格改。
   ============================================================ */

/** 旅慶模板：港島第 82 旅 30 週年旅慶（中英） */
const LV30 = {
  id: 'lv30',
  label: '🏕 30 週年旅慶（中英）',
  note: '2026-10-03（六）至 10-04（日）· 保良局賽馬會北潭涌度假營',
  source: '港島第 82 旅 30 週年旅慶（中英）通告',
  draft: {
    type: 'event',
    title: {
      zh: '港島第 82 旅 30 週年旅慶',
      en: '30th Anniversary of the 82nd Hong Kong Group'
    },
    body: {
      zh: [
        '港島第八十二旅於一九九六年十月一日成立，至今已是第三十個年頭。今年舉辦旅慶活動，讓團員一同慶祝旅團的生日，請各團員踴躍參加。',
        '',
        '內容：覆誓、頒發年度獎項、宿營、年度回顧、燈光營火會、團體遊戲、夜行',
        '日期：2026年10月3日（六）下午 1:00 至 翌日（日）下午 3:00',
        '活動地點：保良局賽馬會北潭涌度假營',
        '集合：1300 香港小童群益會 筲箕灣兒童中心及圖書館',
        '解散：1500 香港小童群益會 筲箕灣兒童中心及圖書館',
        '服裝：整齊深資童軍制服 及 戶外制服',
        '費用：$280（包括營費、膳食、活動物資及旅游車費用；已包括深資童軍 $70 津貼）',
        '',
        '備註：',
        '1. 營地活動只需穿著戶外制服，恆常深資童軍制服可於典禮後換；',
        '2. 帶備宿營物資（足夠替換衣物、梳洗用品、防蚊／防曬用品、水樽、拖鞋等）；',
        '3. 如未提交 26-27 年度會員費，請預備 $360 以繳付團費；',
        '4. 未滿 18 歲成員需由家長簽署同意書。',
        '',
        '家長同意書（未滿 18 歲）：https://www.scout.org.hk/article_attach/10498/pt46.pdf',
        '查詢：6107 0452 莫穎民先生',
        '',
        '報名：撳下面「報名」填寫，即刻寫入執委後台（唔使交紙本回條）。'
      ].join('\n'),
      en: [
        'The 82nd Hong Kong Group was inaugurated on the 1st of October, 1996. This year marks the 30th anniversary of our group. We will commence celebratory activities as a group, and invite all members to attend.',
        '',
        'Content: Re-affirmation of the scout promise, presenting annual awards, indoor camp, yearly reflection, campfire, inter-section games, night hike',
        'Date: 3rd of October (Saturday), 1:00pm to 3:00pm the next day',
        'Location: Po Leung Kuk Pak Tam Chung Holiday Camp',
        'Meeting: 1300 BGCA Shau Kei Wan Children Centre & Library',
        'Dismissal: 1500 BGCA Shau Kei Wan Children Centre & Library',
        'Uniform: Venture Scout Uniform and Outdoor Uniform',
        'Fee: $280 (camp fee, meal fees, activity material and transportation costs; the $70 subsidy for Venture Scouts is already included)',
        '',
        'Notes:',
        '1. Camp activities only require the outdoor uniform; the regular Venture Scout uniform can be changed after the ceremony.',
        '2. Please prepare camp materials (sufficient changes of clothes, toiletries, bug spray / sunscreen, water bottle, slippers, etc.).',
        '3. If you have yet to pay the membership fee for 26-27, please prepare $360.',
        '4. Members under 18 must submit a parental consent form.',
        '',
        'Parental consent form: https://www.scout.org.hk/article_attach/10498/pt46.pdf',
        'Enquiries: Mr. Mok Wing Man (+852 6107 0452)',
        '',
        'Sign up below — it goes straight into the executive committee back office.'
      ].join('\n')
    },
    eventDate: '2026-10-03',
    /* 原通告係「9 月 12 日或之前交回條」；呢個日期已經過（今日 2026-09-16），
       所以刻意留空 ＝ 報名唔會自動截。要設定新截止日就自己填（例：活動前兩日）。 */
    deadline: '',
    venue: '保良局賽馬會北潭涌度假營',
    fee: '$280（已包括深資童軍 $70 津貼）',
    quota: 0,
    needSignup: true,
    /* 報名表欄位：配合本系統（可以直接統計、對名冊、入後端） */
    fields: [
      { key: 'name', label: '姓名', type: 'text', required: true },
      { key: 'ymis', label: '會籍編號 YMIS（如知道）', type: 'text', required: false },
      { key: 'contact', label: '聯絡電話', type: 'tel', required: true },
      { key: 'attend', label: '出席與否', type: 'radio', required: true, options: ['出席', '唔出席（請假）'] },
      { key: 'consent', label: '家長同意書（未滿 18 歲）', type: 'radio', required: true,
        options: ['我會提交家長同意書（未滿 18 歲）', '已滿 18 歲 / 不需要'] },
      { key: 'fee26', label: '26-27 年度會員費', type: 'radio', required: true, options: ['已交', '未交（會補交 $360）'] },
      { key: 'remark', label: '備註（飲食禁忌 / 特別需要）', type: 'textarea', required: false }
    ]
  }
};

export const NOTICE_PRESETS = [LV30];

export function presetById(id) {
  return NOTICE_PRESETS.find(p => p.id === id) || null;
}

/** 套用模板：回傳一份可以直接放入 draft 嘅深層副本（唔會改到原始模板） */
export function presetDraft(id) {
  const p = presetById(id);
  if (!p) return null;
  return {
    patch: JSON.parse(JSON.stringify(p.draft)),
    fields: JSON.parse(JSON.stringify(p.draft.fields || [])),
    label: p.label
  };
}
