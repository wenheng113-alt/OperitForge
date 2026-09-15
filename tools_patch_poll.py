#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给 player.html 打补丁: 轮询兜底 + SSE重连补拉 + 点击乐观反馈"""
import sys, io

def patch(path):
    with io.open(path, 'r', encoding='utf-8') as f:
        s = f.read()
    orig = s
    reps = []

    # 1) applySync 记录最近一次收到 sync 的时间
    old1 = " if(st.seq&&st.seq===lastSeq)return;lastSeq=st.seq||0;"
    new1 = " if(st.seq&&st.seq===lastSeq)return;lastSeq=st.seq||0;lastSeqAt=Date.now();"
    assert s.count(old1) == 1, ("old1 count=%d" % s.count(old1))
    s = s.replace(old1, new1); reps.append('applySync-timestamp')

    # 2) SSE 重连补拉: onopen 标记存活 + 主动拉一次 state
    old2 = " es.onerror=function(){es.close();setTimeout(connect,2500)};"
    new2 = (" es.onerror=function(){es.close();setTimeout(connect,2500)};\n"
            " es.onopen=function(){sseAlive=true;refreshState();};")
    assert s.count(old2) == 1, ("old2 count=%d" % s.count(old2))
    s = s.replace(old2, new2); reps.append('sse-onopen-refresh')

    # 3) 播放按钮乐观反馈: 点击立即切 UI, 不等 SSE
    old3 = "$('playbtn').onclick=function(){pushControl({action:'toggle'})};"
    new3 = ("$('playbtn').onclick=function(){var np=!S.playing;S.playing=np;_shouldPlay=np;"
            "setPlayingUI(np);if(np)ensurePlay();else audio.pause();pushControl({action:'toggle'})};")
    assert s.count(old3) == 1, ("old3 count=%d" % s.count(old3))
    s = s.replace(old3, new3); reps.append('playbtn-optimistic')

    # 4) 初始化后: 全局变量 + refreshState + 轮询兜底
    old4 = "fetch('/state').then(function(r){return r.json()}).then(function(st){applySync(st)}).catch(function(){});"
    new4 = old4 + (
        "\n/* ── 兜底轮询: SSE 断连/后台冻结时也能拿到服务端状态, 保证按钮/进度/歌名不\"卡死\" ── */\n"
        "var lastSeqAt=Date.now(),sseAlive=false;\n"
        "function refreshState(){return fetch('/state').then(function(r){return r.json()}).then(function(st){applySync(st)}).catch(function(){})}\n"
        "setInterval(function(){if(document.hidden)return;if(!sseAlive||Date.now()-lastSeqAt>8000)refreshState();},4000);"
    )
    assert s.count(old4) == 1, ("old4 count=%d" % s.count(old4))
    s = s.replace(old4, new4); reps.append('poll-fallback')

    if s == orig:
        print('NO CHANGE ' + path); return False
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(s)
    print('PATCHED ' + path + ' :: ' + ','.join(reps))
    return True

if __name__ == '__main__':
    for p in sys.argv[1:]:
        patch(p)
