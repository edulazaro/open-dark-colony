import struct,sys,os
from PIL import Image
def load_spr(path):
    d=open(path,'rb').read()
    typ,n,dsz=struct.unpack_from('<HHI',d,0)
    pal=[min(255,b*4+b//16) for b in d[8:8+768]]
    frames=[]
    p=0x308+n*8
    for i in range(n):
        w,h,x,y=struct.unpack_from('<hhhh',d,0x308+i*8)
        px=bytearray(w*h); mask=bytearray(w*h)
        if typ&0x80:
            sz=struct.unpack_from('<I',d,p)[0]; p+=4
            q=p; end=p+sz; o=0
            while q<end and o<w*h:
                c=d[q]; q+=1
                if c>=128: o+=256-c
                else:
                    cnt=c+1
                    px[o:o+cnt]=d[q:q+cnt]; mask[o:o+cnt]=b'\xff'*cnt
                    q+=cnt; o+=cnt
            p=end
        else:
            px[:]=d[p:p+w*h]; p+=w*h
            mask=bytearray(255 if v else 0 for v in px)
        frames.append((w,h,x,y,px,mask))
    return typ,pal,frames
def sheet(path,out,cols=16,scale=1):
    typ,pal,frames=load_spr(path)
    if not frames: return
    mw=max(f[0] for f in frames) or 1; mh=max(f[1] for f in frames) or 1
    cols=min(cols,len(frames)); rows=(len(frames)+cols-1)//cols
    img=Image.new('RGBA',(cols*mw,rows*mh),(40,40,60,255))
    for i,(w,h,x,y,px,mask) in enumerate(frames):
        if w<=0 or h<=0: continue
        im=Image.frombytes('P',(w,h),bytes(px)); im.putpalette(pal)
        im=im.convert('RGBA'); m=Image.frombytes('L',(w,h),bytes(mask))
        img.paste(im,((i%cols)*mw,(i//cols)*mh),m)
    if scale!=1: img=img.resize((img.width*scale,img.height*scale),Image.NEAREST)
    img.save(out)
    print(out,typ,len(frames),mw,mh)
if __name__=='__main__':
    os.makedirs(sys.argv[1],exist_ok=True)
    for f in sys.argv[2:]:
        sheet(f,os.path.join(sys.argv[1],os.path.basename(f)+'.png'))
