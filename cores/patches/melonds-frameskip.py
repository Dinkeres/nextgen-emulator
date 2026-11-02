import sys,os
root=os.path.expanduser('~/ngemu/src/melonDS/src')
def edit(p,pairs):
    p=os.path.join(root,p); s=open(p).read()
    for a,b in pairs:
        if b in s: continue
        assert a in s,(p,a); s=s.replace(a,b,1)
    open(p,'w').write(s)
edit('GPU.h',[("namespace GPU\n{\n","namespace GPU\n{\n\n// Kaiser: when true the current frame is emulated but not drawn (frameskip / fast-forward)\nextern bool SkipFrame;\n")])
edit('GPU.cpp',[("void StartHBlank(u32 line)\n{","bool SkipFrame = false;\n\nvoid StartHBlank(u32 line)\n{"),
 ("        if (line < 192)\n        {\n            GPU2D_Renderer->DrawScanline(line, &GPU2D_A);","        if (line < 192 && !SkipFrame)\n        {\n            GPU2D_Renderer->DrawScanline(line, &GPU2D_A);"),
 ("        if (line < 191)\n        {\n            GPU2D_Renderer->DrawSprites(line+1, &GPU2D_A);","        if (line < 191 && !SkipFrame)\n        {\n            GPU2D_Renderer->DrawSprites(line+1, &GPU2D_A);")])
edit('GPU3D_Soft.cpp',[("void SoftRenderer::RenderFrame()\n{","void SoftRenderer::RenderFrame()\n{\n    // Kaiser frameskip: skip 3D only without the render thread (it expects one frame per VCount144)\n    if (GPU::SkipFrame && !RenderThreadRunning.load(std::memory_order_relaxed)) return;\n")])
edit('libretro/libretro.cpp',[("   if (current_renderer != CurrentRenderer::None) NDS::RunFrame();","   {\n      // Kaiser: honour the frontend's video-enable flag so skipped frames aren't drawn\n      int av = 3;\n      GPU::SkipFrame = environ_cb(RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE, &av) && !(av & 1);\n   }\n   if (current_renderer != CurrentRenderer::None) NDS::RunFrame();")])
print('patched')
