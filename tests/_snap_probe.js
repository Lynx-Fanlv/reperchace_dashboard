(async () => {
  const out=[]; const log=s=>out.push(s); let pass=0,fail=0;
  const ok=(c,m)=>{c?pass++:fail++;log((c?'  ✅ ':'  ❌ ')+m);};
  const A=window.AppCore, P=window.Pipeline;
  const NAME='测试患者',PHONE='13800001111',PROD='百泽安';
  const mk=d=>({source:'sales',_row_id:'f::sales::s::'+d,sales_time:d,order_status:'已完成',
    product_raw:PROD,product:PROD,qty:'1',amount:'1000',member_id:'M1',patient_name:NAME,phone:PHONE,
    hospital:'测试医院',pharmacy:'测试药房',physician:'张医生',department:'肿瘤科',indication:'肺癌',age:'60',gender:'男'});
  A.STORE.sales=[mk('2026-08-01'),mk('2026-09-01')];
  A.STORE.followups=[];A.STORE.cycles={};A.STORE.notes={};A.STORE.reasonOverrides={};A.STORE.cycleOverrides={};
  A.state.stdCycle={'百泽安':21}; A.state.cycleAlgo='reset'; A.state.refDate='2026-09-20'; A.state.weekSel='this';
  A.state.page=1; A.state.pageSize=50;
  const key=P.patientKey(NAME,PHONE)+'::'+PROD;
  A.STORE.cycleOverrides[key]=35;
  A.STORE.notes[key]='已电话联系';
  document.getElementById('board').classList.remove('hidden');
  await A.refresh(); await new Promise(r=>setTimeout(r,300));

  // 生成快照 JSON（复用 doSnapshot 的构造逻辑：直接读 AppCore 内部快照对象不可得，
  // 故改为模拟：构建同样结构的 snap 并调用 loadSnapshot 验证恢复）
  const tr=document.querySelector('tbody tr.data-row');
  const heads=[...document.querySelectorAll('thead th')].map(t=>t.textContent.trim());
  const tds=[...tr.querySelectorAll('td')];
  const cycTxt=tds[heads.indexOf('周期')].textContent.trim();
  const dueTxt=tds[heads.indexOf('应购药日')].textContent.trim();
  log('=== 快照前（主程序）===');
  ok(cycTxt==='35','主程序周期列显示 35');
  log('    应购日 '+dueTxt);

  // 构造快照并用 loadSnapshot 恢复（只读模式）
  const snap={rows:A.DATA.rows.map(r=>Object.assign({},r)),notes:A.STORE.notes,
    reasonOverrides:A.STORE.reasonOverrides,cycleOverrides:A.STORE.cycleOverrides,
    summary:A.buildSummary(A.DATA.rows),
    state:{weekSel:'this',refDate:'2026-09-20',weekEnd:0,pageSize:50,stdCycle:{'百泽安':21},
      cycleAlgo:'reset',cycleTol:7,qtyScale:{},q:'',cats:[],reasons:[],repurParts:[],products:[],
      hospitals:[],pharmacies:[],executors:[],snapFams:[PROD],plainName:false,plainPhone:false,
      plainDoctor:false,scopeNames:true,maskMode:'edge',hiddenCols:[],periodType:'7d',
      periodStart:'',periodEnd:'',selFam:'',reasonTree:A.state.reasonTree,fuAdj:{}},
    buildAt:new Date().toISOString()};
  // 清空后加载，确认恢复
  A.STORE.cycleOverrides={};
  A.loadSnapshot(snap);
  await new Promise(r=>setTimeout(r,500));
  const tr2=document.querySelector('tbody tr.data-row');
  const tds2=[...tr2.querySelectorAll('td')];
  const heads2=[...document.querySelectorAll('thead th')].map(t=>t.textContent.trim());
  const cyc2=tds2[heads2.indexOf('周期')].textContent.trim();
  const due2=tds2[heads2.indexOf('应购药日')].textContent.trim();
  log('\n=== 快照后（只读模式）===');
  ok(Object.keys(A.STORE.cycleOverrides).length===1,'cycleOverrides 已从快照恢复');
  ok(cyc2==='35','快照内周期列显示 35（与生成方一致）');
  ok(due2===dueTxt,'快照内应购日 "'+due2+'" 与生成方一致');
  const ce=tds2[heads2.indexOf('周期')].querySelector('.cycle-edit');
  ok(!!ce,'快照内周期单元格仍在');
  // 快照模式应只读：点击不应出现输入框
  ce.click(); await new Promise(r=>setTimeout(r,250));
  ok(!document.querySelector('input.cycle-input'),'快照模式（只读）点击周期不出现输入框');
  log('\n通过 '+pass+' / '+(pass+fail));
  return out.join('\n');
})()
