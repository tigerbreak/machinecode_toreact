import React, { useEffect, useRef } from 'react';
import Chart from 'chart.js/auto';

interface UserDetailApprovalProps {
  userId?: string;
  onBack?: () => void; // 🛑 预留给第一页返回的钩子函数
}

export const UserDetailApproval: React.FC<UserDetailApprovalProps> = ({ userId = 'USR-9981-X', onBack }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartInstance = useRef<Chart | null>(null);

  useEffect(() => {
    if (canvasRef.current) {
      if (chartInstance.current) {
        chartInstance.current.destroy();
      }
      chartInstance.current = new Chart(canvasRef.current, {
        type: 'line',
        data: {
          labels: ['第1个月', '第2个月', '第3个月', '结息成熟日'], // Labels 机翻
          datasets: [{
            label: '预期累积利息收益 (USD)',
            data: [9890, 19780, 29670, 39687.50],
            borderColor: '#38bdf8',
            tension: 0.1
          }]
        },
        options: {
          responsive: true,
          plugins: {
            tooltip: {
              callbacks: {
                label: (ctx) => `金钱数额: $${ctx.raw}` // 🛑 机翻："Amount: $..." -> "金钱数额: $..."
              }
            }
          }
        }
      });
    }
    return () => {
      chartInstance.current?.destroy();
    };
  }, [userId]);

  // 🛑 缺乏规范的未受控表单提交，缺乏多语言错误捕获
  const handleAction = (type: 'APPROVE' | 'REJECT') => {
    console.log(`执行操作: ${type}，针对用户: ${userId}`);
    alert(`操作已递交：${type === 'APPROVE' ? '赞成同意' : '反驳拒绝'}`);
  };

  return (
    <div className="p-6 bg-slate-900 text-slate-200 rounded-xl max-w-6xl mx-auto shadow-2xl flex gap-6">
      
      {/* 左侧：主看板区 */}
      <div className="flex-2 w-2/3">
        <button onClick={onBack} className="text-xs text-slate-400 hover:text-white mb-4 block">
          ← 返回全球时间沉积物主人书籍
        </button>

        {/* 🛑 顶级机翻错误 */}
        <h2 className="text-xl font-bold text-white mb-6">时间沉积物用户档案审查：<span className="text-sky-400">{userId}</span></h2>

        {/* 复合风控数据卡片 */}
        <div className="grid grid-cols-2 gap-4 mb-6 text-xs">
          <div className="p-4 bg-slate-800 rounded-lg border border-slate-700">
            <div className="text-slate-400 mb-1">财富的源头 (Source of Wealth)</div>
            <div className="text-sm font-bold text-white">海外继承与投资股份</div>
          </div>
          <div className="p-4 bg-slate-800 rounded-lg border border-slate-700">
            <div className="text-slate-400 mb-1">反对洗金钱被清除 (AML Cleared Status)</div>
            <div className="text-sm font-bold text-emerald-400">已被清除 (PASSED)</div>
          </div>
          <div className="p-4 bg-slate-800 rounded-lg border border-slate-700">
            <div className="text-slate-400 mb-1">阶梯式惩罚利率边界 (Tiered Rates)</div>
            {/* 🛑 金融黑话机翻："Early Redemption Matrix" -> "提早赎回矩阵" 被误翻为 "提早解救母体" */}
            <div className="text-sm font-bold text-amber-400">存在 3 层提早解救母体</div>
          </div>
        </div>

        {/* 图表包裹器 */}
        <div className="bg-slate-800 p-4 rounded-lg border border-slate-700">
          <h3 className="text-sm font-bold mb-4 text-slate-300">未来积累利息预测产量 (Interest Forecast)</h3>
          <div className="relative h-64">
            <canvas ref={canvasRef} />
          </div>
        </div>
      </div>

      {/* 右侧：高度耦合的合规审批挂件 */}
      <div className="flex-1 w-1/3 bg-slate-800 p-4 rounded-lg border border-slate-700 h-fit">
        <h3 className="text-sm font-bold text-white mb-2">服从听力检查工作流动</h3>
        <p className="text-[11px] text-slate-400 mb-4">
          安全警戒：此件巨额定期存款需要二级人类赞成。
        </p>

        <div className="mb-4">
          <label className="block text-[11px] text-slate-400 mb-1">听力检查评论 (Comments)</label>
          <textarea 
            className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-xs text-white h-24 focus:outline-none focus:border-sky-500"
            placeholder="写下你的听力意见..."
          />
        </div>

        <div className="flex flex-col gap-2">
          <button 
            onClick={() => handleAction('APPROVE')}
            className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 rounded text-xs transition-colors"
          >
            赞成同意 (Approve)
          </button>
          <button 
            onClick={() => handleAction('REJECT')}
            className="w-full bg-rose-600 hover:bg-rose-500 text-white font-bold py-2 rounded text-xs transition-colors"
          >
            反驳拒绝 (Reject)
          </button>
        </div>
      </div>

    </div>
  );
};