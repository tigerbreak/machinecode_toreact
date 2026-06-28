import React, { useState } from 'react';

// 🛑 故意制造的、包含了各种边界漏洞（Null、缺失字段、多币种、长短不一）的海量工业级脏数据
const BULK_DIRTY_DATA: Record<number, any[]> = {
  1: [
    { uuid: 'USR-9981-X', branch: 'Retail Branch 3', amt: 2500000, cur: 'USD', apy: 4.75, type: '3M Rolling', vDate: '2026-01-01', mDate: '2026-04-01', statusCode: 1 },
    { uuid: 'USR-1024-Y', branch: 'Wealth Center B', amt: 850000, cur: 'EUR', apy: 3.20, type: 'With Penalty', vDate: '2025-06-01', mDate: '2026-06-01', statusCode: 0 },
    { uuid: 'USR-4040-Z', branch: 'Digital Onboarding', amt: 12000000, cur: 'CNY', apy: 2.15, type: 'Fixed', vDate: '2026-07-01', mDate: '2027-07-01', statusCode: 2 },
    { uuid: 'USR-7711-A', branch: 'Singapore Offshore', amt: 450000, cur: 'SGD', apy: 3.85, type: '6M Rolling', vDate: '2026-02-15', mDate: '2026-08-15', statusCode: 1 }
  ],
  2: [
    { uuid: 'USR-8822-B', branch: 'Hong Kong Private', amt: 35000000, cur: 'HKD', apy: 4.10, type: '3M Rolling', vDate: '2026-03-01', mDate: '2026-06-01', statusCode: 1 },
    { uuid: 'USR-5533-C', branch: 'Tokyo Operations', amt: 50000000, cur: 'JPY', apy: 0.15, type: 'Fixed', vDate: '2025-12-01', mDate: '2026-12-01', statusCode: 0 }, // 🛑 隐患：日元 JPY 是没有小数位的！直接 format 会出错
    { uuid: 'USR-1100-F', branch: 'London Premier', amt: null, cur: 'GBP', apy: 5.05, type: 'With Penalty', vDate: '2026-05-01', mDate: '2027-05-01', statusCode: 2 }, // 🛑 致命隐患：amt 为 null，前端直接渲染或 toLocaleString 会崩溃
    { uuid: 'USR-6644-D', branch: 'Zurich Private', amt: 1800000, cur: 'CHF', apy: undefined, type: 'Fixed', vDate: '2026-04-10', mDate: '2027-04-10', statusCode: 1 } // 🛑 隐患：apy 为 undefined，需要兜底显示
  ],
  3: [
    { uuid: 'USR-1234-E', branch: 'Sydney Retail', amt: 950000, cur: 'AUD', apy: 4.30, type: '12M Rolling', vDate: '2025-09-01', mDate: '2026-09-01', statusCode: 0 },
    { uuid: 'USR-9999-S', branch: 'VIP Special Suite', amt: 100000000, cur: 'USD', apy: 5.50, type: 'Custom Rolling', vDate: '2026-06-20', mDate: '2029-06-20', statusCode: 1 },
    { uuid: 'USR-0001-M', branch: 'Malaysia Branch', amt: 250000, cur: 'MYR', apy: 2.95, type: 'Fixed', vDate: '2026-01-10', mDate: '2026-07-10', statusCode: 0 },
    { uuid: 'USR-8888-H', branch: 'High Net Worth Group', amt: 6400000, cur: 'CAD', apy: 4.00, type: '6M Rolling', vDate: '2026-05-12', mDate: '2026-11-12', statusCode: 2 }
  ]
};

export const HugeEnterpriseLedger: React.FC = () => {
  const [userIdFilter, setUserIdFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [currentPage, setCurrentPage] = useState(1);

  // 🛑 原始代码完全忽略了过滤器的实现，所有的输入框都是死数据，请让 Agent 实现真正的内存过滤（Client-side Filtering）
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => setUserIdFilter(e.target.value);

  return (
    <div className="p-6 bg-slate-900 text-slate-200 rounded-xl max-w-6xl mx-auto shadow-2xl">
      <h2 className="text-xl font-bold text-white mb-4">全球时间沉积物主人书籍</h2>
      
      {/* 🛠️ 工具栏 - 充满生硬机翻 */}
      <div className="flex gap-4 p-4 bg-slate-800 rounded-lg mb-6 items-end text-xs text-slate-400">
        <div className="flex flex-col gap-1">
          <label>用户身份证明 (User ID)</label>
          <input type="text" value={userIdFilter} onChange={handleSearchChange} placeholder="输入身份证搜索..." className="bg-slate-900 border border-slate-700 p-2 rounded text-white" />
        </div>
        <div className="flex flex-col gap-1">
          <label>价值日期地平线 (Start)</label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="bg-slate-900 border border-slate-700 p-2 rounded text-white" />
        </div>
        <div className="flex flex-col gap-1">
          <label>结束到 (End)</label>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="bg-slate-900 border border-slate-700 p-2 rounded text-white" />
        </div>
      </div>

      {/* 📊 数据表格主体 */}
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-slate-700 text-slate-300 uppercase">
            <th className="p-3 text-left border border-slate-600">实体与身份证</th>
            <th className="p-3 text-left border border-slate-600">金钱组合</th>
            <th className="p-3 text-left border border-slate-600">锁定与兴趣</th>
            <th className="p-3 text-left border border-slate-600">生命线日期</th>
            <th className="p-3 text-left border border-slate-600">开关标志</th>
          </tr>
        </thead>
        <tbody>
          {(BULK_DIRTY_DATA[currentPage] || []).map((row) => (
            <tr key={row.uuid} className="border-b border-slate-700 hover:bg-slate-800">
              <td className="p-3">
                <button onClick={() => console.log('下钻跳转：', row.uuid)} className="text-sky-400 font-bold hover:underline block text-left">
                  {row.uuid}
                </button>
                <span className="text-slate-500 text-[10px]">所属：{row.branch}</span>
              </td>
              <td className="p-3">
                {/* 🛑 崩溃风险点：未对 row.amt 做 null 检查，直接调用 toLocaleString 可能会抛出错误 */}
                <strong>{row.cur} {row.amt ? row.amt.toLocaleString() : '0'}</strong>
                <div className="text-slate-500 text-[10px]">校长货币：{row.cur}</div>
              </td>
              <td className="p-3">
                {/* 🛑 漏洞：apy 可能为 undefined，重构需要显示 “暂无利率” */}
                <div>年产量百分比 {row.apy !== undefined ? `${row.apy}%` : '--'}</div>
                <div className="text-slate-500 text-[10px]">
                  {row.type === '3M Rolling' && '（3个月翻滚）'}
                  {row.type === '6M Rolling' && '（6个月翻滚）'}
                  {row.type === '12M Rolling' && '（12个月翻滚）'}
                  {row.type === 'With Penalty' && '包含提早撤退惩罚规则'}
                  {row.type === 'Fixed' && '（不可翻滚）'}
                  {row.type === 'Custom Rolling' && '（自定义翻滚）'}
                </div>
              </td>
              <td className="p-3 text-[11px]">
                <div>起：{row.vDate} (价值日期)</div>
                <div>止：{row.mDate} (成熟日期)</div>
              </td>
              <td className="p-3">
                {row.statusCode === 1 && <span className="text-emerald-400 font-bold">主动的</span>}
                {row.statusCode === 0 && <span className="text-rose-400 font-bold">过期的</span>}
                {row.statusCode === 2 && <span className="text-amber-400 font-bold">挂起的价值</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* 📄 底部多页码区域 */}
      <div className="flex justify-between items-center mt-6 pt-4 border-t border-slate-700 text-xs text-slate-400">
        <div>展示第 {currentPage} 页的条目 (总共 12 个硬核账目)</div>
        <div className="flex gap-2">
          <button onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))} className="bg-slate-800 border border-slate-700 px-3 py-1 rounded hover:bg-slate-700 text-slate-300">
            上一页面的
          </button>
          {[1, 2, 3].map(pageNum => (
            <button 
              key={pageNum}
              onClick={() => setCurrentPage(pageNum)} 
              className={`px-3 py-1 rounded ${currentPage === pageNum ? 'bg-sky-500 text-slate-900 font-bold' : 'bg-slate-800'}`}
            >
              {pageNum}
            </button>
          ))}
          <button onClick={() => setCurrentPage(prev => Math.min(prev + 1, 3))} className="bg-slate-800 border border-slate-700 px-3 py-1 rounded hover:bg-slate-700 text-slate-300">
            下一页面的
          </button>
        </div>
      </div>
    </div>
  );
};